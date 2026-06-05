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
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';

async function main() {
  const apply = process.argv.includes('--apply');
  const ttlMin = Number(process.env.TTL_MINUTES ?? 60);
  if (!Number.isFinite(ttlMin) || ttlMin <= 0) {
    console.error('TTL_MINUTES must be a positive number');
    process.exit(1);
  }
  const cutoff = new Date(Date.now() - ttlMin * 60_000);
  console.log(`[release-stale] mode=${apply ? 'APPLY' : 'DRY-RUN'} ttl=${ttlMin}min cutoff=${cutoff.toISOString()}`);

  const stores = await pool.query<{ id: string; slug: string }>('SELECT id, slug FROM store');
  let totalOrders = 0;
  let totalReleased = 0;

  for (const st of stores.rows) {
    const res = await withStore(st.id, async (tx) => {
      const stale = await tx
        .select({ id: s.order.id, code: s.order.code, createdAt: s.order.createdAt })
        .from(s.order)
        .where(and(eq(s.order.state, 'PendingPayment'), lt(s.order.createdAt, cutoff)));
      let released = 0;
      for (const o of stale) {
        const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
        if (apply) {
          for (const l of lines) {
            const rel = l.quantity - l.fulfilledQty;
            if (rel > 0 && l.variantId) {
              await tx
                .update(s.stock)
                .set({ allocated: sql`greatest(${s.stock.allocated} - ${rel}, 0)` })
                .where(and(eq(s.stock.variantId, l.variantId), eq(s.stock.storeId, st.id)));
              released += rel;
            }
          }
          await tx.update(s.order).set({ state: 'Cancelled', updatedAt: new Date() }).where(eq(s.order.id, o.id));
          await tx.insert(s.auditLog).values({
            storeId: st.id, actor: 'system:reservation-expiry', entity: 'order', entityId: o.id,
            action: 'cancel', fromState: 'PendingPayment', toState: 'Cancelled', data: { reason: 'stale_unpaid', ttlMin },
          });
        } else {
          released += lines.reduce((n, l) => n + Math.max(l.quantity - l.fulfilledQty, 0), 0);
        }
      }
      return { count: stale.length, released };
    });
    totalOrders += res.count;
    totalReleased += res.released;
    if (res.count) console.log(`[release-stale] ${st.slug}: ${apply ? 'cancelled' : 'would cancel'} ${res.count} orders, ${apply ? 'released' : 'would release'} ${res.released} units`);
  }

  console.log(`[release-stale] done: ${totalOrders} orders, ${totalReleased} units${apply ? '' : ' (DRY RUN — re-run with --apply to act)'}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
