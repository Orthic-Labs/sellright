/** Cart lifecycle jobs: mark inactive non-empty carts abandoned (emit an event
 *  for analytics/recovery), and hard-delete idle/empty carts past their TTL.
 *  Per-store, store-scoped via withStore. Mirrors the other jobs' shape
 *  (release-stale-allocations / webhook-reaper): a single idempotent pass, the
 *  caller owns the pool lifecycle, never run from tests.
 */
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { emitEvent } from '../webhooks/emit.js';

// Cap per run so a backlog of stale carts spreads across ticks instead of a
// single synchronous storm of UPDATE + emitEvent (jury: event-burst bound).
const ABANDON_BATCH = 500;

async function activeStoreIds(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>('select id from store');
  return rows.map((r) => r.id);
}

/** Mark active carts with items + no activity for `windowHours` as abandoned. */
export async function abandonStaleCarts(windowHours: number): Promise<{ abandoned: number }> {
  let abandoned = 0;
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  for (const storeId of await activeStoreIds()) {
    abandoned += await withStore(storeId, async (tx) => {
      const stale = await tx
        .select({ id: s.cart.id, token: s.cart.token, email: s.cart.email })
        .from(s.cart)
        .where(and(eq(s.cart.status, 'active'), isNull(s.cart.convertedOrderId), lt(s.cart.updatedAt, cutoff),
          sql`exists (select 1 from cart_line cl where cl.cart_id = ${s.cart.id})`))
        .limit(ABANDON_BATCH);
      for (const c of stale) {
        await tx.update(s.cart).set({ status: 'abandoned', updatedAt: new Date() }).where(eq(s.cart.id, c.id));
        await emitEvent(tx, storeId, 'cart.abandoned', { token: c.token, email: c.email });
      }
      return stale.length;
    });
  }
  return { abandoned };
}

/** Purge ONLY idle/empty expired carts (active, no lines) past TTL. Abandoned
 *  carts are KEPT — they are the analytics/recovery record, so cleanup never
 *  destroys abandonment data (council P1). Batched delete, no per-row loop. */
export async function cleanupExpiredCarts(): Promise<{ deleted: number }> {
  let deleted = 0;
  const now = new Date();
  for (const storeId of await activeStoreIds()) {
    deleted += await withStore(storeId, async (tx) => {
      const stale = await tx.select({ id: s.cart.id }).from(s.cart).where(
        and(lt(s.cart.expiresAt, now), eq(s.cart.status, 'active'), isNull(s.cart.convertedOrderId),
          sql`not exists (select 1 from cart_line cl where cl.cart_id = ${s.cart.id})`));
      if (!stale.length) return 0;
      const ids = stale.map((c) => c.id);
      await tx.delete(s.cartLine).where(inArray(s.cartLine.cartId, ids)); // defensive; none expected
      await tx.delete(s.cart).where(inArray(s.cart.id, ids));
      return ids.length;
    });
  }
  return { deleted };
}
