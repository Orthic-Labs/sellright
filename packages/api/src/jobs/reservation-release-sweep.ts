import { importedFinancialReconciliationRequired } from '../orders/imported-financial-reconciliation.js';
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

/**
 * D8: per-store rotation cursor (order_id keyset). Orders the sweep cannot
 * settle yet (provider work not quiescent) keep their marker; with a plain
 * LIMIT they re-occupied the window every pass and starved everything behind
 * them. Each pass resumes after the last order it examined and wraps around, so
 * every candidate is examined within ceil(candidates / batchLimit) passes.
 * In-memory on purpose: losing it on restart just restarts the rotation.
 */
const sweepCursor = new Map<string, string>();

/** Test hook. */
export function resetReservationSweepCursor(): void { sweepCursor.clear(); }

/**
 * Candidate orders in stable order_id order, resuming after the store's cursor.
 * Only rows this sweep can act on qualify (same outcome as the per-order
 * checks under the lock, which remain authoritative):
 *  - held + release requested (R4), or
 *  - consumed + release requested on a Refunded order (R5 retry);
 *    consumed rows of any other order are a no-op for this sweep.
 *  - imported orders awaiting financial reconciliation are skipped under the
 *    lock anyway (metadata.vendure.financialReconciliationV1), so they are
 *    excluded here instead of permanently holding window slots.
 */
async function sweepCandidates(storeId: string, batchLimit: number): Promise<string[]> {
  const page = (after: string | null) => withStore(storeId, (tx) => tx.execute(sql`
    SELECT r.order_id AS id
      FROM order_reservation r
      JOIN "order" o ON o.id = r.order_id AND o.store_id = r.store_id
     WHERE r.store_id = ${storeId} AND r.release_requested_at IS NOT NULL
       AND (r.state = 'held' OR (r.state = 'consumed' AND o.state = 'Refunded'))
       AND NOT coalesce(jsonb_typeof(o.metadata->'vendure') = 'object' AND (o.metadata->'vendure') ? 'financialReconciliationV1', false)
       AND (${after}::uuid IS NULL OR r.order_id > ${after}::uuid)
     GROUP BY r.order_id
     ORDER BY r.order_id
     LIMIT ${batchLimit}`)).then((r) => (r as unknown as { rows: Array<{ id: string }> }).rows.map((row) => row.id));
  const after = sweepCursor.get(storeId) ?? null;
  let ids = await page(after);
  if (after && ids.length < batchLimit) {
    // Wrap around: fill the rest of the window from the start, without repeats.
    const seen = new Set(ids);
    for (const id of await page(null)) {
      if (ids.length >= batchLimit || seen.has(id)) break;
      ids = [...ids, id];
    }
  }
  if (ids.length) sweepCursor.set(storeId, ids[ids.length - 1]!);
  else sweepCursor.delete(storeId);
  return ids;
}

export async function reservationReleaseSweep(opts: ReservationSweepOpts = {}): Promise<ReservationSweepResult> {
  const log = opts.log ?? (() => {});
  const batchLimit = opts.batchLimit && opts.batchLimit > 0 ? Math.floor(opts.batchLimit) : 100;
  const result: ReservationSweepResult = { orders: 0, released: 0, deferred: 0, skipped: 0, errors: 0 };
  const stores = await pool.query<{ id: string; slug: string; config: unknown }>('SELECT id, slug, config FROM store');
  for (const st of stores.rows) {
    // No transaction is open while the discovery flag is evaluated.
    const stripeDiscover = await stripeDiscoverable(st.id, st.config);
    const ids = await sweepCandidates(st.id, batchLimit);
    for (const orderId of ids) {
      try {
        const out = await withLockedSet(st.id, { kind: 'order', orderId }, async (tx, held) => {
          const [o] = await tx.execute(sql`SELECT state, metadata FROM "order" WHERE id = ${orderId} AND store_id = ${st.id} FOR UPDATE`)
            .then((r) => (r as unknown as { rows: Array<{ state: string; metadata: unknown }> }).rows);
          if (!o || importedFinancialReconciliationRequired(o.metadata)) return { released: 0, deferred: 0 };
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
