/**
 * Auto-Delivered cron (DD order-tools parity): mark Shipped fulfillments older
 * than N days as Delivered. Single idempotent pass; schedule via cron/BullMQ.
 * Usage: tsx src/jobs/auto-deliver.ts            # DRY RUN
 *        DAYS=10 tsx src/jobs/auto-deliver.ts --apply
 *
 * PERF-12 (apply OPS-2's pattern): the old implementation was a row-by-row
 * select + per-fulfillment UPDATE loop — O(N) round-trips per store per tick,
 * and worst of all, NOT safe under concurrent execution. Two scheduler
 * instances (or two overlapping manual runs) would both SELECT the same
 * Shipped fulfillments and BOTH apply Delivered — harmless on its own (the
 * target state is idempotent) but the per-row auditLog insert would fire
 * twice, the per-row UPDATE would race, and any future side-effect added on
 * the Delivered transition would double-fire too.
 *
 * Fix mirrors release-stale-allocations.ts (OPS-2): claim a batch under
 * `FOR UPDATE SKIP LOCKED LIMIT N` so a concurrent pass skips rows already
 * locked here, then mark the entire claimed batch with ONE batched UPDATE
 * and ONE batched auditLog insert — single transaction, single round-trip per
 * store per claim. Belt + suspenders with the scheduler's advisory
 * leader-lock (leader-lock.ts): the lock keeps the tick to one instance, and
 * the SKIP LOCKED makes a manual run that bypasses the lock still safe.
 *
 * Concurrency model:
 *   - The select FOR UPDATE SKIP LOCKED holds a row-level lock on every
 *     claimed fulfillment for the lifetime of the txn. A concurrent pass's
 *     SELECT skips those rows instead of blocking, so the two passes do not
 *     double-claim the same fulfillment.
 *   - The UPDATE and auditLog insert run on the SAME txn — either both apply
 *     for every claimed row, or neither does. A crash mid-txn rolls back the
 *     lock; the next pass re-claims the same rows cleanly.
 *   - Dry-run (default, no JOBS_AUTO_DELIVER_APPLY=1) takes the same SELECT
 *     path with the same lock — operators still see the count of "would
 *     deliver" per store, but no UPDATE / auditLog fires.
 */
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';

export type AutoDeliverOpts = { apply: boolean; days: number; log?: (m: string) => void; batchLimit?: number };

const DEFAULT_BATCH_LIMIT = 200;

/**
 * One idempotent pass: mark Shipped fulfillments older than `days` as Delivered.
 * Reusable from the CLI wrapper or the scheduler. Caller owns the pool lifecycle.
 */
export async function autoDeliver(opts: AutoDeliverOpts): Promise<number> {
  const { apply, days } = opts;
  const log = opts.log ?? (() => {});
  const batchLimit = opts.batchLimit && opts.batchLimit > 0 ? Math.floor(opts.batchLimit) : DEFAULT_BATCH_LIMIT;
  if (!Number.isFinite(days) || days <= 0) throw new Error('days must be a positive number');
  const cutoff = new Date(Date.now() - days * 86_400_000);
  log(`[auto-deliver] mode=${apply ? 'APPLY' : 'DRY-RUN'} days=${days} cutoff=${cutoff.toISOString()}`);

  const stores = await pool.query<{ id: string; slug: string }>('SELECT id, slug FROM store');
  let total = 0;

  for (const st of stores.rows) {
    const n = await withStore(st.id, async (tx) => {
      // Claim a batch of Shipped fulfillments past the cutoff, holding the
      // row-level lock for the txn so a concurrent pass (manual run that
      // bypassed the leader lock, overlapping scheduler tick) skips any row
      // already locked here. LIMIT batchLimit caps the txn's lock surface so
      // a single huge backlog can't pin the table.
      const claimed = await tx.execute(
        sql`SELECT id, order_id
            FROM fulfillment
            WHERE store_id = ${st.id}
              AND state = 'Shipped'
              AND updated_at < ${cutoff}
            ORDER BY updated_at
            LIMIT ${batchLimit}
            FOR UPDATE SKIP LOCKED`,
      );
      const due = (claimed as unknown as { rows: Array<{ id: string; order_id: string }> }).rows;
      if (!due.length) return 0;

      const fulfillmentIds = due.map((f) => f.id);

      if (apply) {
        // Single batched UPDATE: every claimed fulfillment in one statement,
        // not a per-row loop — one round-trip, one lock-pass, and a concurrent
        // pass cannot slip a duplicate update in between because the rows are
        // still locked at txn commit. Plain array interpolation into the sql
        // template renders `IN (uuid1, uuid2, ...)` (drizzle expands bare
        // arrays into a LIST TO EXPAND; this is the same form
        // release-stale-allocations uses for its orderIds).
        await tx.execute(
          sql`UPDATE fulfillment
              SET state = 'Delivered', updated_at = now()
              WHERE id IN ${fulfillmentIds}`,
        );
        // Single batched audit insert: one row per claimed fulfillment, all
        // attached to the same txn so either the whole batch is auditable or
        // none of it is.
        await tx.insert(s.auditLog).values(
          due.map((f) => ({
            storeId: st.id,
            actor: 'system:auto-deliver',
            entity: 'order',
            entityId: f.order_id,
            action: 'auto_delivered',
            toState: 'Delivered',
            data: { days },
          })),
        );
      }

      return due.length;
    });
    total += n;
    if (n) log(`[auto-deliver] ${st.slug}: ${apply ? 'delivered' : 'would deliver'} ${n}`);
  }
  log(`[auto-deliver] done: ${total}${apply ? '' : ' (DRY RUN — --apply to act)'}`);
  return total;
}

// CLI entry: `tsx src/jobs/auto-deliver.ts [--apply]` (DAYS env).
const isCli = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('auto-deliver.ts');
if (isCli) {
  autoDeliver({ apply: process.argv.includes('--apply'), days: Number(process.env.DAYS ?? 10), log: (m) => console.log(m) })
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}