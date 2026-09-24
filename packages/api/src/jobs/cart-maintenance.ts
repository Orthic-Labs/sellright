/** Cart lifecycle jobs (CART-04): mark inactive non-empty carts abandoned
 *  (emit an event for analytics/recovery), hard-delete idle/empty carts past
 *  their TTL, and purge abandoned carts past the retention window.
 *
 *  Lifecycle config is explicit and per-store: `store.config.cart` keys
 *  `abandonAfterHours` / `ttlDays` / `retentionDays` override the deployment
 *  defaults (env CART_ABANDON_HOURS / CART_TTL_DAYS / CART_RETENTION_DAYS) —
 *  see cart/ttl.ts ::cartLifecycleFromConfig. Owner decision 2026-09-24:
 *  idle carts (including abandoned, non-converted) are kept 24 hours —
 *  CART_TTL_DAYS and CART_RETENTION_DAYS both default to 1 day. A store can
 *  still opt into a longer per-store retention window via
 *  config.cart.retentionDays (any positive number of days overrides the
 *  deployment default; there is no "retain forever" config value once a
 *  deployment default is set — raise CART_RETENTION_DAYS instead).
 *
 *  Hard invariants:
 *   - never delete orders; converted carts are never purged either —
 *     converted_order_id anchors payment recovery on the order.
 *   - never cross tenants: every store runs in its own withStore tx (RLS)
 *     AND every query carries an explicit store_id filter — migration/job
 *     roles can be BYPASSRLS, so RLS alone is not the tenant boundary here.
 *   - an email captured on a cart is NOT verified account ownership — it earns
 *     no retention/protection privilege; policy keys on status + age only.
 *   - every write bumps cart.revision (CART-03) and is status-guarded, so a
 *     cart converted or edited between scan and write is never clobbered.
 *   - scan→write race protocol (CART-05): candidate scans lock their rows
 *     FOR UPDATE inside the store tx and every write rechecks FULL
 *     eligibility in its predicate (expiry, status, idleness, emptiness at
 *     delete time). Every cart mutation writes the cart row, so a shopper
 *     racing this pass either commits before we lock (Postgres re-evaluates
 *     the scan predicate on the fresh row version — EvalPlanQual — and the
 *     cart is never selected) or queues behind our lock and lands after our
 *     commit. cart_lines are deleted only for carts this pass actually
 *     deletes — never stripped from a cart that survives.
 *
 *  Per-store, store-scoped via withStore. Mirrors the other jobs' shape
 *  (release-stale-allocations / webhook-reaper): a single idempotent pass, the
 *  caller owns the pool lifecycle, never run from tests.
 */
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { emitEvent } from '../webhooks/emit.js';
import { env } from '../env.js';
import { cartLifecycleFromConfig, type CartLifecycleConfig } from '../cart/ttl.js';

// Cap per run so a backlog of stale carts spreads across ticks instead of a
// single synchronous storm of UPDATE + emitEvent (jury: event-burst bound).
const ABANDON_BATCH = 500;
const PURGE_BATCH = 500;

async function activeStores(): Promise<Array<{ id: string; config: unknown }>> {
  const { rows } = await pool.query<{ id: string; config: unknown }>('select id, config from store');
  return rows;
}

const lifecycleFor = (config: unknown, fallbackHours: number): CartLifecycleConfig =>
  cartLifecycleFromConfig(config, {
    abandonAfterHours: fallbackHours,
    ttlDays: env.CART_TTL_DAYS,
    retentionDays: env.CART_RETENTION_DAYS,
  });

/** Mark active carts with items + no activity past the store's inactivity
 *  window as abandoned. `defaultWindowHours` is the deployment default (env),
 *  overridden per store by config.cart.abandonAfterHours. */
export async function abandonStaleCarts(defaultWindowHours: number): Promise<{ abandoned: number }> {
  let abandoned = 0;
  for (const store of await activeStores()) {
    const cutoff = new Date(Date.now() - lifecycleFor(store.config, defaultWindowHours).abandonAfterHours * 60 * 60 * 1000);
    abandoned += await withStore(store.id, async (tx) => {
      // Scan-and-lock in one step (FOR UPDATE): a shopper write to one of
      // these rows blocks our scan until it commits, then Postgres
      // re-evaluates the predicate on the fresh version — a cart touched in
      // the window is dropped before it is ever a candidate. Once locked, a
      // candidate row cannot change under us.
      const stale = await tx
        .select({ id: s.cart.id, token: s.cart.token, email: s.cart.email })
        .from(s.cart)
        .where(and(eq(s.cart.storeId, store.id), eq(s.cart.status, 'active'), isNull(s.cart.convertedOrderId), lt(s.cart.updatedAt, cutoff),
          sql`exists (select 1 from cart_line cl where cl.cart_id = ${s.cart.id})`))
        .limit(ABANDON_BATCH)
        .for('update');
      let flipped = 0;
      for (const c of stale) {
        // Full-eligibility recheck in the write predicate (still active,
        // still unconverted, still idle past the cutoff, still non-empty):
        // under the FOR UPDATE lock this is infallible — it exists so the
        // write stays correct even if the lock discipline above is ever
        // weakened. The event fires only for carts we actually flipped.
        const [row] = await tx.update(s.cart)
          .set({ status: 'abandoned', updatedAt: new Date(), revision: sql`${s.cart.revision} + 1` })
          .where(and(eq(s.cart.id, c.id), eq(s.cart.status, 'active'), isNull(s.cart.convertedOrderId), lt(s.cart.updatedAt, cutoff),
            sql`exists (select 1 from cart_line cl where cl.cart_id = ${s.cart.id})`))
          .returning({ id: s.cart.id });
        if (row) { flipped += 1; await emitEvent(tx, store.id, 'cart.abandoned', { token: c.token, email: c.email }); }
      }
      return flipped;
    });
  }
  return { abandoned };
}

/** Statuses the TTL rule may purge: 'active' = idle session carts, 'merged' =
 *  consumed merge donors (terminal and always line-less — the merge deletes
 *  their rows — so they follow the same expiry clock). 'abandoned' carts
 *  belong to the retention rule below (opt-in), 'converted' carts are never
 *  purged. */
const TTL_PURGEABLE: Array<'active' | 'merged'> = ['active', 'merged'];

/** Purge expired EMPTY carts past their TTL (active + merged), and — only
 *  when the store configured config.cart.retentionDays — abandoned carts idle
 *  past that window. Converted carts are never deleted (payment-recovery
 *  anchor) and orders are never touched. Batched deletes, no per-row loop. */
export async function cleanupExpiredCarts(): Promise<{ deleted: number }> {
  let deleted = 0;
  const now = new Date();
  for (const store of await activeStores()) {
    const lifecycle = lifecycleFor(store.config, env.CART_ABANDON_HOURS);
    deleted += await withStore(store.id, async (tx) => {
      // Scan-and-lock in one step (FOR UPDATE): every shopper mutation writes
      // the cart row, so a cart touched in the scan→write window either is
      // re-evaluated on its fresh version when the lock wait resolves
      // (EvalPlanQual — fresh expiresAt, or a just-committed line failing the
      // not-exists check) or waits for our commit. Once locked, candidates
      // cannot change under us.
      const ttlDoomed = await tx.select({ id: s.cart.id }).from(s.cart).where(
        and(eq(s.cart.storeId, store.id), lt(s.cart.expiresAt, now), inArray(s.cart.status, TTL_PURGEABLE), isNull(s.cart.convertedOrderId),
          sql`not exists (select 1 from cart_line cl where cl.cart_id = ${s.cart.id})`))
        .limit(PURGE_BATCH)
        .for('update');

      let aged: Array<{ id: string }> = [];
      let retentionCutoff: Date | null = null;
      if (lifecycle.retentionDays != null) {
        // Retention window on abandoned carts only — 'active'/'merged' carts
        // are owned by the TTL rule above; 'converted' carts are never purged.
        retentionCutoff = new Date(now.getTime() - lifecycle.retentionDays * 24 * 60 * 60 * 1000);
        aged = await tx.select({ id: s.cart.id }).from(s.cart).where(
          and(eq(s.cart.storeId, store.id), eq(s.cart.status, 'abandoned'), isNull(s.cart.convertedOrderId), lt(s.cart.updatedAt, retentionCutoff)))
          .limit(PURGE_BATCH)
          .for('update');
      }
      if (!ttlDoomed.length && !aged.length) return 0;

      // Strip lines only for carts this pass is deleting — the retention set
      // carries its lines into the purge (the FK needs them gone first), and
      // the TTL set is empty by predicate so this is a no-op for it. Locked
      // candidates can't escape the delete below, so no surviving cart ever
      // loses lines here.
      const doomed = [...new Set([...ttlDoomed, ...aged].map((c) => c.id))];
      await tx.delete(s.cartLine).where(inArray(s.cartLine.cartId, doomed));

      let gone = 0;
      if (ttlDoomed.length) {
        // Recheck FULL eligibility at delete time: still expired, still a
        // purgeable status, still unconverted, and STILL EMPTY — a cart that
        // gained a line in the window is skipped, not emptied-and-deleted.
        gone += (await tx.delete(s.cart).where(
          and(eq(s.cart.storeId, store.id), inArray(s.cart.id, ttlDoomed.map((c) => c.id)),
            lt(s.cart.expiresAt, now), inArray(s.cart.status, TTL_PURGEABLE), isNull(s.cart.convertedOrderId),
            sql`not exists (select 1 from cart_line cl where cl.cart_id = ${s.cart.id})`))
          .returning({ id: s.cart.id })).length;
      }
      if (aged.length) {
        // Same for the retention rule: still abandoned, still unconverted,
        // still idle past the cutoff — a resumed cart (status back to
        // 'active', fresh updatedAt) survives untouched.
        gone += (await tx.delete(s.cart).where(
          and(eq(s.cart.storeId, store.id), inArray(s.cart.id, aged.map((c) => c.id)),
            eq(s.cart.status, 'abandoned'), isNull(s.cart.convertedOrderId), lt(s.cart.updatedAt, retentionCutoff!)))
          .returning({ id: s.cart.id })).length;
      }
      return gone;
    });
  }
  return { deleted };
}
