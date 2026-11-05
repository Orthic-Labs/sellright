/**
 * Abandoned-order trash (#359): an unpaid order that the stale-unpaid job (release-stale-allocations.ts) cancelled is
 * moved to the trash (soft delete: `deleted_at`) `minutes` after that cancellation (default 60). Trash, never purge: the
 * order stays restorable from the admin and nothing is hard-deleted here.
 *
 * Scope is the cancellation source, not the state. The stale job stamps `cancelSource = 'release-stale'` on the audit
 * row that moves the order to Cancelled (orders/cancel-unpaid.ts). Only an order whose LATEST move to Cancelled carries
 * that stamp qualifies, so a merchant cancel, a shopper cart reopen, or any path that stamps nothing is never trashed,
 * even if the order was also stale-cancelled earlier and later restored and re-cancelled.
 *
 * Never trashed, whatever the source: an order that was ever paid, authorised or refunded (a payment that is not
 * Declined/Failed, a payment attempt that is not failed/cancelled, a refund, a fulfilment, a dispute, or an audit row that
 * moved it to Paid/PartiallyRefunded/Refunded), imported history (reconciliation marker), `metadata.retainCancelled`,
 * and an order already in the trash.
 *
 * Each trashed order gets one audit row (`trash`, actor `system:abandoned-order-trash`). The audit row has NO to_state:
 * the purge job (#374) reads the latest `to_state = 'Cancelled'` row as the cancellation time and must not be reset.
 *
 * Usage:
 *   tsx src/jobs/trash-abandoned-orders.ts            # DRY RUN (prints only)
 *   MINUTES=60 tsx src/jobs/trash-abandoned-orders.ts --apply
 */
import { sql } from 'drizzle-orm';
import { currentLeaseSignal, pool, withStore } from '../db/client.js';
import { LockSetUnstable, withLockedSet } from '../db/locks.js';
import { importedFinancialReconciliationPath } from '../import/source-compatibility.js';
import { CANCEL_SOURCE_RELEASE_STALE } from '../orders/cancel-unpaid.js';

export type TrashAbandonedOpts = { apply: boolean; minutes: number; log?: (m: string) => void; batchLimit?: number; now?: Date };
export const TRASH_ABANDONED_ACTOR = 'system:abandoned-order-trash';
export const TRASH_ABANDONED_DEFAULT_MINUTES = 60;

const DEFAULT_BATCH_LIMIT = 200;

/** The audit row that last moved the order to Cancelled (correlated on the outer `"order"`). */
const latestCancel = sql`(SELECT al.at, al.data FROM audit_log al
    WHERE al.store_id = "order".store_id AND al.entity = 'order' AND al.entity_id = "order".id::text AND al.to_state = 'Cancelled'
    ORDER BY al.at DESC, al.id DESC LIMIT 1)`;

/**
 * A Cancelled, not-yet-trashed order whose latest cancellation was by release-stale before `cutoff` and that never
 * touched money. Shared by the unlocked candidate read and the re-check under the lock set.
 */
export function trashableAbandonedPredicate(storeId: string, cutoff: Date) {
  return sql`"order".state = 'Cancelled' AND "order".store_id = ${storeId} AND "order".deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM ${latestCancel} lc WHERE lc.data->>'cancelSource' = ${CANCEL_SOURCE_RELEASE_STALE} AND lc.at < ${cutoff})
    AND ("order".metadata #> ARRAY[${importedFinancialReconciliationPath[0]}, ${importedFinancialReconciliationPath[1]}]::text[]) IS NULL
    AND coalesce(("order".metadata->>'retainCancelled')::boolean, false) = false
    AND NOT EXISTS (SELECT 1 FROM payment p WHERE p.order_id = "order".id AND p.state NOT IN ('Declined', 'Failed'))
    AND NOT EXISTS (SELECT 1 FROM payment_attempt pa WHERE pa.order_id = "order".id AND pa.status NOT IN ('failed', 'cancelled'))
    AND NOT EXISTS (SELECT 1 FROM refund r WHERE r.order_id = "order".id)
    AND NOT EXISTS (SELECT 1 FROM fulfillment f WHERE f.order_id = "order".id)
    AND NOT EXISTS (SELECT 1 FROM dispute d WHERE d.order_id = "order".id)
    AND NOT EXISTS (SELECT 1 FROM audit_log ap WHERE ap.store_id = "order".store_id AND ap.entity = 'order' AND ap.entity_id = "order".id::text
      AND ap.to_state IN ('Paid', 'PartiallyRefunded', 'Refunded'))`;
}

/** One idempotent pass over every store. Does NOT close the pool — the caller owns its lifecycle. */
export async function trashAbandonedOrders(opts: TrashAbandonedOpts): Promise<{ trashed: number; skipped: number }> {
  const { apply, minutes } = opts;
  const log = opts.log ?? (() => {});
  const batchLimit = opts.batchLimit && opts.batchLimit > 0 ? Math.floor(opts.batchLimit) : DEFAULT_BATCH_LIMIT;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('minutes must be a positive number');
  const cutoff = new Date((opts.now ?? new Date()).getTime() - minutes * 60_000);

  const stores = await pool.query<{ id: string; slug: string }>('SELECT id, slug FROM store');
  let trashed = 0;
  let skipped = 0;
  for (const st of stores.rows) {
    const candidates = await withStore(st.id, (tx) => tx.execute(
      sql`SELECT id, code FROM "order" WHERE ${trashableAbandonedPredicate(st.id, cutoff)} ORDER BY created_at LIMIT ${batchLimit}`,
    ));
    const rows = (candidates as unknown as { rows: Array<{ id: string; code: string }> }).rows;
    for (const { id: orderId, code } of rows) {
      if (currentLeaseSignal()?.aborted) break; // lease lost — leave the rest to the new leader
      if (!apply) { log(`[trash-abandoned] ${st.slug}: would trash ${code}`); trashed++; continue; }
      try {
        const r = await withLockedSet(st.id, { kind: 'order', orderId }, async (tx) => {
          const claimed = await tx.execute(sql`SELECT id, (SELECT lc.at FROM ${latestCancel} lc) AS cancelled_at FROM "order"
            WHERE id = ${orderId} AND ${trashableAbandonedPredicate(st.id, cutoff)} FOR UPDATE`);
          const o = (claimed as unknown as { rows: Array<{ id: string; cancelled_at: Date | string }> }).rows[0];
          if (!o) return false;
          await tx.execute(sql`UPDATE "order" SET deleted_at = now(), updated_at = now() WHERE id = ${orderId} AND deleted_at IS NULL`);
          await tx.execute(sql`INSERT INTO audit_log (store_id, actor, entity, entity_id, action, data)
            VALUES (${st.id}, ${TRASH_ABANDONED_ACTOR}, 'order', ${orderId}, 'trash',
              ${JSON.stringify({ reason: 'abandoned_cancelled', cancelSource: CANCEL_SOURCE_RELEASE_STALE, cancelledAt: new Date(o.cancelled_at).toISOString(), minutes })}::jsonb)`);
          return true;
        });
        if (r) { trashed++; log(`[trash-abandoned] ${st.slug}: trashed ${code}`); }
        else { skipped++; log(`[trash-abandoned] ${st.slug}: kept ${code} (no longer eligible)`); }
      } catch (e) {
        if (!(e instanceof LockSetUnstable)) throw e;
        skipped++;
        log(`[trash-abandoned] ${st.slug}: skipped ${code} (lock set unavailable; a later tick retries)`);
      }
    }
  }
  if (trashed || skipped) log(`[trash-abandoned] done: ${apply ? 'trashed' : 'would trash'} ${trashed}, kept ${skipped} (cancelled before ${cutoff.toISOString()})${apply ? '' : ' (DRY RUN — re-run with --apply to act)'}`);
  return { trashed, skipped };
}

const isCli = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('trash-abandoned-orders.ts');
if (isCli) {
  trashAbandonedOrders({ apply: process.argv.includes('--apply'), minutes: Number(process.env.MINUTES ?? TRASH_ABANDONED_DEFAULT_MINUTES), log: (m) => console.log(m) })
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
