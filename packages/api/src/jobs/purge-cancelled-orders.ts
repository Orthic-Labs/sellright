/**
 * Cancelled-order expiry (#374) — the order housekeeping the stores ran before SellRight: an unpaid order is cancelled by the
 * stale-unpaid job (release-stale-allocations.ts), and a Cancelled order is permanently deleted once it has been
 * cancelled for `hours` (default 24). Deletion goes through the same purge cascade as the admin's "Delete
 * permanently" (orders/purge.ts), audited as `purge` with actor `system:cancelled-order-expiry`.
 *
 * Only money-free orders qualify. An order is kept when it has any payment that is not Declined/Failed, any payment
 * attempt that is not failed/cancelled (so an unknown, processing, open or settled attempt always holds it), a
 * refund, a fulfilment, a dispute, imported history, or `metadata.retainCancelled = true` (an operator's keep
 * marker). purgeRefusal then re-applies the admin purge guards (reservations, credit holds) under the lock set.
 *
 * The cancellation time is the latest audit row moving the order to Cancelled; an order cancelled without one
 * (older code paths) falls back to `updated_at`.
 *
 * Usage:
 *   tsx src/jobs/purge-cancelled-orders.ts            # DRY RUN (prints only)
 *   tsx src/jobs/purge-cancelled-orders.ts --apply
 */
import { sql } from 'drizzle-orm';
import { currentLeaseSignal, pool, withStore } from '../db/client.js';
import { LockSetUnstable, withLockedSet } from '../db/locks.js';
import { onStockChanged } from '../manifest/stock-hook.js';
import { stripeDiscoverable } from '../payments/stripe-reconcile.js';
import { importedFinancialReconciliationPath } from '../import/source-compatibility.js';
import { purgeOrderInSet, purgeRefusal } from '../orders/purge.js';

export type PurgeCancelledOpts = { apply: boolean; hours: number; log?: (m: string) => void; batchLimit?: number; now?: Date };
export const PURGE_CANCELLED_ACTOR = 'system:cancelled-order-expiry';

const DEFAULT_BATCH_LIMIT = 100;

const cancelledAtSql = sql`coalesce((SELECT max(al.at) FROM audit_log al
    WHERE al.store_id = "order".store_id AND al.entity = 'order' AND al.entity_id = "order".id::text AND al.to_state = 'Cancelled'),
  "order".updated_at)`;

/** A Cancelled, money-free order cancelled before `cutoff`. Shared by the unlocked candidate read and the re-check under the set. */
export function purgeableCancelledPredicate(storeId: string, cutoff: Date) {
  return sql`"order".state = 'Cancelled' AND "order".store_id = ${storeId} AND ${cancelledAtSql} < ${cutoff}
    AND ("order".metadata #> ARRAY[${importedFinancialReconciliationPath[0]}, ${importedFinancialReconciliationPath[1]}]::text[]) IS NULL
    AND coalesce(("order".metadata->>'retainCancelled')::boolean, false) = false
    AND NOT EXISTS (SELECT 1 FROM payment p WHERE p.order_id = "order".id AND p.state NOT IN ('Declined', 'Failed'))
    AND NOT EXISTS (SELECT 1 FROM payment_attempt pa WHERE pa.order_id = "order".id AND pa.status NOT IN ('failed', 'cancelled'))
    AND NOT EXISTS (SELECT 1 FROM refund r WHERE r.order_id = "order".id)
    AND NOT EXISTS (SELECT 1 FROM fulfillment f WHERE f.order_id = "order".id)
    AND NOT EXISTS (SELECT 1 FROM dispute d WHERE d.order_id = "order".id)`;
}

/** One idempotent pass over every store. Does NOT close the pool — the caller owns its lifecycle. */
export async function purgeCancelledOrders(opts: PurgeCancelledOpts): Promise<{ purged: number; skipped: number }> {
  const { apply, hours } = opts;
  const log = opts.log ?? (() => {});
  const batchLimit = opts.batchLimit && opts.batchLimit > 0 ? Math.floor(opts.batchLimit) : DEFAULT_BATCH_LIMIT;
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('hours must be a positive number');
  const cutoff = new Date((opts.now ?? new Date()).getTime() - hours * 3_600_000);

  const stores = await pool.query<{ id: string; slug: string; config: unknown }>('SELECT id, slug, config FROM store');
  let purged = 0;
  let skipped = 0;
  for (const st of stores.rows) {
    const discoverable = await stripeDiscoverable(st.id, st.config);
    const candidates = await withStore(st.id, (tx) => tx.execute(
      sql`SELECT id, code FROM "order" WHERE ${purgeableCancelledPredicate(st.id, cutoff)} ORDER BY created_at LIMIT ${batchLimit}`,
    ));
    const rows = (candidates as unknown as { rows: Array<{ id: string; code: string }> }).rows;
    let stockChanged = false;
    for (const { id: orderId, code } of rows) {
      if (currentLeaseSignal()?.aborted) break; // lease lost — leave the rest to the new leader
      if (!apply) { log(`[purge-cancelled] ${st.slug}: would delete ${code}`); purged++; continue; }
      try {
        const r = await withLockedSet(st.id, { kind: 'order', orderId }, async (tx, held) => {
          const claimed = await tx.execute(sql`SELECT id, code, state, metadata, ${cancelledAtSql} AS cancelled_at FROM "order"
            WHERE id = ${orderId} AND ${purgeableCancelledPredicate(st.id, cutoff)} FOR UPDATE`);
          const o = (claimed as unknown as { rows: Array<{ id: string; code: string; state: string; metadata: unknown; cancelled_at: Date | string }> }).rows[0];
          if (!o) return { ok: false as const, error: 'no longer eligible' };
          const refusal = await purgeRefusal(tx, st.id, o, { stripeDiscoverable: discoverable, force: false });
          if (refusal) return { ok: false as const, error: refusal.error };
          const res = await purgeOrderInSet(tx, held, { storeId: st.id, order: o, actor: PURGE_CANCELLED_ACTOR,
            data: { reason: 'cancelled_expired', cancelledAt: new Date(o.cancelled_at).toISOString(), hours } });
          return { ok: true as const, stockChanged: res.stockChanged };
        });
        if (r.ok) {
          purged++;
          stockChanged ||= r.stockChanged;
          log(`[purge-cancelled] ${st.slug}: deleted ${code}`);
        } else {
          skipped++;
          log(`[purge-cancelled] ${st.slug}: kept ${code} (${r.error})`);
        }
      } catch (e) {
        if (!(e instanceof LockSetUnstable)) throw e;
        skipped++;
        log(`[purge-cancelled] ${st.slug}: skipped ${code} (lock set unavailable; a later tick retries)`);
      }
    }
    // Zero-cache stock rule: regenerate only after the purges committed, never on a dry run.
    if (apply && stockChanged) onStockChanged(st.slug);
  }
  if (purged || skipped) log(`[purge-cancelled] done: ${apply ? 'deleted' : 'would delete'} ${purged}, kept ${skipped} (cancelled before ${cutoff.toISOString()})`);
  return { purged, skipped };
}

const isCli = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('purge-cancelled-orders.ts');
if (isCli) {
  purgeCancelledOrders({ apply: process.argv.includes('--apply'), hours: Number(process.env.HOURS ?? 24), log: (m) => console.log(m) })
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
