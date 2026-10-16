// Reservation release safety net (PAYMENT-TIMING §5.2, de-fork plan 3.3).
//
// Every cancel path requests release (R3) and settles it in the same transaction when provider work is
// quiescent. This sweep closes the gaps a lost event leaves behind: a request whose settlement never ran
// (a crash between the provider-terminal write and the release), and an R5 full-refund projection that a
// failing policy hook deferred (the consumed rows keep release_requested_at). It runs every 15 min, leader
// locked, one order per lock set. Provider discovery is evaluated before any transaction (no I/O inside one).
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { LockSetUnstable, withLockedSet } from '../db/locks.js';
import { releaseOnFullRefundOrDefer, settleRelease } from '../payments/reservation.js';
import { stripeDiscoverable } from '../payments/stripe-reconcile.js';

export interface ReservationSweepOpts {
  batchLimit?: number;
  log?: (message: string) => void;
}

export interface ReservationSweepResult { orders: number; released: number; deferred: number; skipped: number; errors: number }

export async function reservationReleaseSweep(opts: ReservationSweepOpts = {}): Promise<ReservationSweepResult> {
  const log = opts.log ?? (() => {});
  const batchLimit = opts.batchLimit && opts.batchLimit > 0 ? Math.floor(opts.batchLimit) : 100;
  const result: ReservationSweepResult = { orders: 0, released: 0, deferred: 0, skipped: 0, errors: 0 };
  const stores = await pool.query<{ id: string; slug: string; config: unknown }>('SELECT id, slug, config FROM store');
  for (const st of stores.rows) {
    // No transaction is open while the discovery flag is evaluated.
    const stripeDiscover = await stripeDiscoverable(st.id, st.config);
    const candidates = await withStore(st.id, (tx) => tx.execute(sql`
      SELECT DISTINCT order_id AS id FROM order_reservation
       WHERE store_id = ${st.id} AND state IN ('held', 'consumed') AND release_requested_at IS NOT NULL
       LIMIT ${batchLimit}`));
    const ids = (candidates as unknown as { rows: Array<{ id: string }> }).rows.map((r) => r.id);
    for (const orderId of ids) {
      try {
        const out = await withLockedSet(st.id, { kind: 'order', orderId }, async (tx, held) => {
          const [o] = await tx.execute(sql`SELECT state FROM "order" WHERE id = ${orderId} AND store_id = ${st.id}`)
            .then((r) => (r as unknown as { rows: Array<{ state: string }> }).rows);
          if (!o) return { released: 0, deferred: 0 };
          let released = 0;
          let deferred = 0;
          if (o.state === 'Refunded') {
            // R5 retry: a deferred full-refund projection (consumed rows, release_on_full_refund).
            const r5 = await releaseOnFullRefundOrDefer(tx, held, { storeId: st.id, orderId });
            released += r5.released.length;
            if (r5.deferred) deferred++;
          }
          // R4 retry: requested releases of held rows, effective only when terminal and quiescent.
          const r4 = await settleRelease(tx, held, { storeId: st.id, orderId, stripeDiscoverable: stripeDiscover });
          released += r4.length;
          return { released, deferred };
        });
        result.orders++;
        result.released += out.released;
        result.deferred += out.deferred;
        if (out.released) log(`[reservation-sweep] ${st.slug}: order ${orderId} released=${out.released}`);
      } catch (e) {
        if (e instanceof LockSetUnstable) { result.skipped++; continue; }
        result.errors++;
        log(`[reservation-sweep] ${st.slug}: order ${orderId} failed: ${(e as Error).message}`);
      }
    }
  }
  return result;
}
