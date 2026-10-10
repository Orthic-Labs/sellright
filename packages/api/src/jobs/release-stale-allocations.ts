/**
 * Reservation expiry — the "release on timeout" half of the soft-reservation
 * pattern (rulebook: allocate at order-creation + release on timeout; research
 * §6). An abandoned `PendingPayment` order holds `allocated` stock forever; this
 * job cancels stale unpaid orders and releases their reservation.
 *
 * Runs as the OWNER role across all stores (it sets store context per store).
 * Schedule it (BullMQ/cron) later; this is a single idempotent pass.
 *
 * Usage:
 *   tsx src/jobs/release-stale-allocations.ts            # DRY RUN (prints only)
 *   TTL_MINUTES=60 tsx src/jobs/release-stale-allocations.ts --apply
 *
 * DRY RUN is the default on purpose: the imported DD catalog has thousands of
 * historical PendingPayment orders that are NOT abandoned carts — never
 * mass-cancel them by accident. Inspect the dry-run output before --apply.
 *
 * Concurrency (OPS-2): the scheduler's advisory leader-lock (leader-lock.ts)
 * already keeps this job to one instance per tick, but the select below is ALSO
 * claim-safe on its own (`FOR UPDATE SKIP LOCKED LIMIT`, mirroring
 * webhooks/emit.ts's deliverWebhooks claim query) — belt + suspenders in case
 * the job is ever invoked outside the leader-locked scheduler (the CLI entry
 * point at the bottom of this file, a manual ops run, etc.). The per-variant
 * stock release is a single batched UPDATE…FROM (VALUES …) instead of a
 * per-line loop, so a crash mid-pass (or, previously, a second unlocked
 * instance) cannot apply the same release twice — a claimed order is either
 * fully processed in one UPDATE or not processed at all.
 */
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { LockSetUnstable, withLockedSet } from '../db/locks.js';
import * as s from '../db/schema.js';
import { onStockChanged } from '../manifest/stock-hook.js';
import { releaseOrderLoyalty } from '../loyalty/ledger.js';
import { sweepStaleStripeIntents, sweepStaleBalanceIntents, sweepOrphanPreMints, discoverStaleUntrackedIntents, stripeDiscoverable } from '../payments/stripe-reconcile.js';

export type ReleaseStaleOpts = { apply: boolean; ttlMin: number; log?: (m: string) => void; batchLimit?: number };

const DEFAULT_BATCH_LIMIT = 200;

/** Stale-unpaid predicates (shared by the unlocked candidate read and the re-check under the set). */
function stalePredicate(storeId: string, cutoff: Date, requireDiscovery: boolean) {
  return sql`state = 'PendingPayment' AND created_at < ${cutoff} AND store_id = ${storeId}
    AND NOT EXISTS (SELECT 1 FROM payment_attempt pa
      WHERE pa.order_id = "order".id AND pa.store_id = "order".store_id
        AND (pa.status IN ('processing', 'unknown', 'pending')
          -- D5: a tracked Stripe intent not yet resolved at Stripe
          OR (pa.operation = 'intent' AND pa.status IN ('open', 'failed', 'action_required'))))
    -- untracked-intent discovery failed: hold, never cancel blindly
    AND coalesce((metadata->'stripeDiscovery'->>'hold')::boolean, false) = false
    AND (${!requireDiscovery}
      OR EXISTS (SELECT 1 FROM payment_attempt pi WHERE pi.order_id = "order".id AND pi.store_id = "order".store_id AND pi.operation = 'intent')
      OR (metadata->'stripeDiscovery'->>'checkedAt') IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM payment p
      WHERE p.order_id = "order".id AND p.store_id = "order".store_id
        AND p.state IN ('Pending', 'Authorized'))`;
}

/**
 * One idempotent pass: cancel stale unpaid orders and release their stock
 * reservation. Reusable from the CLI wrapper (manual) or the scheduler. Does NOT
 * close the pool — the caller owns the pool lifecycle.
 */
export async function releaseStaleAllocations(opts: ReleaseStaleOpts): Promise<{ orders: number; released: number; skipped: number }> {
  const { apply, ttlMin } = opts;
  const log = opts.log ?? (() => {});
  const batchLimit = opts.batchLimit && opts.batchLimit > 0 ? Math.floor(opts.batchLimit) : DEFAULT_BATCH_LIMIT;
  if (!Number.isFinite(ttlMin) || ttlMin <= 0) throw new Error('ttlMin must be a positive number');
  const cutoff = new Date(Date.now() - ttlMin * 60_000);
  log(`[release-stale] mode=${apply ? 'APPLY' : 'DRY-RUN'} ttl=${ttlMin}min cutoff=${cutoff.toISOString()}`);

  const stores = await pool.query<{ id: string; slug: string; config: unknown }>('SELECT id, slug, config FROM store');
  let totalOrders = 0;
  let totalReleased = 0;
  let skipped = 0;

  for (const st of stores.rows) {
    // D5: resolve tracked Stripe intents at Stripe BEFORE cancelling: a
    // succeeded PI settles (never cancel paid money), processing/
    // requires_action holds, anything else is cancelled at Stripe first.
    // Stripe is called with no transaction open. Dry-run never touches Stripe;
    // orders with unresolved intents are skipped by the claim below either way.
    // A Stripe-enabled store may only cancel an order whose Stripe side is
    // known: it has tracked intents, or discovery searched Stripe clean.
    const requireDiscovery = await stripeDiscoverable(st.id, st.config);
    if (apply) {
      // Untracked-intent gap: search Stripe for PIs on stale orders that have
      // no intent attempt (pre-tracking PIs, lost attempt inserts) so the
      // tracked sweep below can settle/hold/cancel them.
      const dv = await discoverStaleUntrackedIntents(st.id, st.config, cutoff, batchLimit, log);
      if (dv.checked) log(`[release-stale] ${st.slug}: stripe discovery checked=${dv.checked} found=${dv.found} held=${dv.held} flagged=${dv.flagged}`);
      const sw = await sweepStaleStripeIntents(st.id, cutoff, batchLimit, log);
      if (sw.checked) log(`[release-stale] ${st.slug}: stripe intents checked=${sw.checked} settled=${sw.settled} held=${sw.held} cancelled=${sw.cancelled} errors=${sw.errors}`);
      // PAYMENT-TIMING §5.4: balance intents on Paid orders past the deadline, and pre-mint rows (X-9) past it.
      const bal = await sweepStaleBalanceIntents(st.id, batchLimit, log);
      if (bal.checked) log(`[release-stale] ${st.slug}: balance intents checked=${bal.checked} settled=${bal.settled} held=${bal.held} cancelled=${bal.cancelled} errors=${bal.errors}`);
      const orph = await sweepOrphanPreMints(st.id, batchLimit, log);
      if (orph.checked) log(`[release-stale] ${st.slug}: pre-mint rows checked=${orph.checked} bound=${orph.bound} cancelled=${orph.cancelled} errors=${orph.errors}`);
    }
    // STOREKIT §5.4 (F1): candidates are read unlocked, then each order is taken on its
    // own under withLockedSet({order}) — the set plans its licences and locks them before
    // the order — and the stale predicates are re-checked under that lock. An order whose
    // set cannot be taken (lock timeout / plan churn: LockSetUnstable) is skipped and
    // picked up by a later tick; it never blocks the rest of the batch.
    const candidates = await withStore(st.id, (tx) => tx.execute(
      sql`SELECT id FROM "order" WHERE ${stalePredicate(st.id, cutoff, requireDiscovery)} ORDER BY created_at LIMIT ${batchLimit}`,
    ));
    const ids = (candidates as unknown as { rows: Array<{ id: string }> }).rows.map((r) => r.id);
    let storeCount = 0;
    let storeReleased = 0;
    for (const orderId of ids) {
      try {
        const res = await withLockedSet(st.id, { kind: 'order', orderId }, async (tx) => {
          const claimed = await tx.execute(
            sql`SELECT id, code, created_at FROM "order" WHERE id = ${orderId} AND ${stalePredicate(st.id, cutoff, requireDiscovery)}`,
          );
          const stale = (claimed as unknown as { rows: Array<{ id: string; code: string; created_at: Date }> }).rows;
          if (!stale.length) return { count: 0, released: 0 };

          const lines = await tx
            .select({ orderId: s.orderLine.orderId, variantId: s.orderLine.variantId, quantity: s.orderLine.quantity, fulfilledQty: s.orderLine.fulfilledQty, cancelledQty: s.orderLine.cancelledQty })
            .from(s.orderLine)
            .where(eq(s.orderLine.orderId, orderId));

          // Aggregate the release per variant BEFORE writing anything, so the stock
          // UPDATE is a single batched statement for the order.
          const releaseByVariant = new Map<string, number>();
          let released = 0;
          for (const l of lines) {
            const rel = l.quantity - l.fulfilledQty - l.cancelledQty;
            if (rel > 0 && l.variantId) {
              releaseByVariant.set(l.variantId, (releaseByVariant.get(l.variantId) ?? 0) + rel);
              released += rel;
            }
          }

          if (apply) {
            if (releaseByVariant.size) {
              const variantIds = [...releaseByVariant.keys()];
              const amounts = variantIds.map((id) => releaseByVariant.get(id)!);
              // sql.param() is required (drizzle would otherwise expand the array into a
              // row expression): one array-valued parameter per column for unnest().
              await tx.execute(
                sql`UPDATE stock
                    SET allocated = greatest(allocated - v.amount, 0)
                    FROM (SELECT * FROM unnest(${sql.param(variantIds)}::uuid[], ${sql.param(amounts)}::int[]) AS t(variant_id, amount)) AS v
                    WHERE stock.variant_id = v.variant_id AND stock.store_id = ${st.id}`,
              );
            }
            // D6: record the released units as cancelled on the line, so a later refund
            // of a paid-after-cancel order (MONEY-4) computes unfulfilled = 0.
            await tx.execute(
              sql`UPDATE order_line SET cancelled_qty = quantity - fulfilled_qty
                  WHERE order_id = ${orderId} AND quantity - fulfilled_qty - cancelled_qty > 0`,
            );
            await tx.execute(sql`UPDATE "order" SET state = 'Cancelled', updated_at = now() WHERE id = ${orderId}`);
            // LOYALTY-1: an unpaid order that times out gives its reserved points back.
            await releaseOrderLoyalty(tx, st.id, orderId, 'system:reservation-expiry');
            await tx.insert(s.auditLog).values({
              storeId: st.id, actor: 'system:reservation-expiry', entity: 'order', entityId: orderId,
              action: 'cancel', fromState: 'PendingPayment', toState: 'Cancelled', data: { reason: 'stale_unpaid', ttlMin },
            });
          }

          return { count: 1, released };
        });
        storeCount += res.count;
        storeReleased += res.released;
      } catch (e) {
        if (!(e instanceof LockSetUnstable)) throw e;
        skipped++;
        log(`[release-stale] ${st.slug}: skipped order ${orderId} (lock set unavailable; a later tick retries)`);
      }
    }
    const res = { count: storeCount, released: storeReleased };
    totalOrders += res.count;
    totalReleased += res.released;
    if (res.count) log(`[release-stale] ${st.slug}: ${apply ? 'cancelled' : 'would cancel'} ${res.count} orders, ${apply ? 'released' : 'would release'} ${res.released} units`);
    // Zero-cache stock rule: each release committed in its own set transaction before this
    // runs — trigger the manifest regeneration only after commit, never on a dry run.
    if (apply && res.released > 0) onStockChanged(st.slug);
  }

  log(`[release-stale] done: ${totalOrders} orders, ${totalReleased} units${apply ? '' : ' (DRY RUN — re-run with --apply to act)'}`);
  return { orders: totalOrders, released: totalReleased, skipped };
}

// CLI entry: `tsx src/jobs/release-stale-allocations.ts [--apply]` (TTL_MINUTES env).
// Only runs when executed directly, not when imported by the scheduler.
const isCli = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('release-stale-allocations.ts');
if (isCli) {
  releaseStaleAllocations({ apply: process.argv.includes('--apply'), ttlMin: Number(process.env.TTL_MINUTES ?? 60), log: (m) => console.log(m) })
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
