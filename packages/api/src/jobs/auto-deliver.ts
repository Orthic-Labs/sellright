/**
 * Auto-Delivered cron (DD order-tools parity): mark fully shipped, tracked orders
 * whose shipments are older than N days as Delivered (rule: candidateWhere below).
 * Single idempotent pass; schedule via cron/BullMQ.
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
 *   - Dry-run (JOBS_AUTO_DELIVER_APPLY=0; applying is the default since #396) takes the same SELECT
 *     path with the same lock — operators still see the count of "would
 *     deliver" per store, but no UPDATE / auditLog fires.
 */
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';

export type AutoDeliverOpts = { apply: boolean; days: number; log?: (m: string) => void; batchLimit?: number; maxOrders?: number };

const DEFAULT_BATCH_LIMIT = 200;
const SAMPLE_LIMIT = 25;

// `code` is the order code; `trackingCode`/`carrier` join every distinct value across the order's shipments.
export type AutoDeliverSample = { code: string; trackingCode: string | null; carrier: string | null; shippedAt: string };
export type AutoDeliverStoreResult = { count: number; sample: AutoDeliverSample[]; days: number; cutoff: string; apply: boolean };

function assertDays(days: number): void {
  if (!Number.isFinite(days) || days <= 0) throw new Error('days must be a positive number');
}

/** Latest shipment update for the order: the previous platform's MAX(f."updatedAt") (delivered-order-check.service.ts:113). */
const SHIPPED_AT = sql`(SELECT max(f.updated_at) FROM fulfillment f WHERE f.order_id = o.id AND f.state = 'Shipped')`;

/**
 * Candidate rule, ported 1:1 from the previous platform's getCandidateOrders
 * (delivered-order-check.service.ts:107-136): the order is Shipped, ALL its
 * fulfillments are Shipped, every one has a non-empty tracking code, and the
 * newest shipment update is older than the cutoff. SellRight has no
 * "Shipped" order state (order.state stays Paid/PartiallyRefunded; shipping
 * lives on fulfillments + order_line.fulfilled_qty, orders/status.ts), so
 * "order in Shipped" is: Paid/PartiallyRefunded, not trashed, every remaining
 * line fully fulfilled. Cancelled fulfillments are ignored (as
 * deriveFulfillmentStatus does); Pending or Delivered ones disqualify, like
 * the previous platform's BOOL_AND(f.state = 'Shipped').
 */
function candidateWhere(storeId: string, cutoff: Date) {
  return sql`o.store_id = ${storeId}
    AND o.state IN ('Paid', 'PartiallyRefunded')
    AND o.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM fulfillment f WHERE f.order_id = o.id AND f.state = 'Shipped')
    AND NOT EXISTS (SELECT 1 FROM fulfillment f WHERE f.order_id = o.id AND f.state NOT IN ('Shipped', 'Cancelled'))
    AND NOT EXISTS (SELECT 1 FROM fulfillment f WHERE f.order_id = o.id AND f.state = 'Shipped' AND btrim(coalesce(f.tracking_code, '')) = '')
    AND NOT EXISTS (SELECT 1 FROM order_line ol WHERE ol.order_id = o.id AND ol.quantity - ol.cancelled_qty > ol.fulfilled_qty)
    AND ${SHIPPED_AT} <= ${cutoff}`;
}

/**
 * One store's pass. `maxBatches` > 1 keeps claiming (apply mode) until the
 * backlog is drained or the cap is hit — the cron path leaves it at 1, the
 * admin "run now" endpoint raises it. `exact` makes a dry run report the true
 * total via a plain COUNT instead of the size of one locked batch.
 * `maxOrders` caps the orders handled in the whole pass (the previous platform's maxOrders,
 * delivered-order-check.service.ts:67/127); `count` is orders, not fulfillments.
 */
export async function autoDeliverStore(
  storeId: string,
  opts: { apply: boolean; days: number; batchLimit?: number; maxBatches?: number; exact?: boolean; maxOrders?: number },
): Promise<AutoDeliverStoreResult> {
  const { apply, days } = opts;
  assertDays(days);
  const batchLimit = opts.batchLimit && opts.batchLimit > 0 ? Math.floor(opts.batchLimit) : DEFAULT_BATCH_LIMIT;
  const maxBatches = Math.max(1, Math.floor(opts.maxBatches ?? 1));
  const maxOrders = opts.maxOrders && opts.maxOrders > 0 ? Math.floor(opts.maxOrders) : Infinity;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  let count = 0;
  const sample: AutoDeliverSample[] = [];

  for (let batch = 0; batch < maxBatches && count < maxOrders; batch++) {
    const limit = Math.min(batchLimit, maxOrders - count);
    const n = await withStore(storeId, async (tx) => {
      // Claim a batch of candidate orders, holding the row-level lock on the
      // order row for the txn (the fulfil routes lock the same row, so a
      // concurrent ship/fulfil waits and a concurrent pass skips it). LIMIT
      // caps the txn's lock surface so a single huge backlog can't pin the table.
      const claimed = await tx.execute(
        sql`SELECT o.id, o.code, ${SHIPPED_AT} AS shipped_at,
              (SELECT string_agg(DISTINCT f.tracking_code, ', ') FROM fulfillment f WHERE f.order_id = o.id AND f.state = 'Shipped') AS tracking_codes,
              (SELECT string_agg(DISTINCT f.carrier, ', ') FROM fulfillment f WHERE f.order_id = o.id AND f.state = 'Shipped') AS carriers
            FROM "order" o
            WHERE ${candidateWhere(storeId, cutoff)}
            ORDER BY shipped_at
            LIMIT ${limit}
            FOR UPDATE OF o SKIP LOCKED`,
      );
      const due = (claimed as unknown as { rows: Array<{ id: string; code: string; shipped_at: Date | string; tracking_codes: string | null; carriers: string | null }> }).rows;
      if (!due.length) return 0;

      for (const o of due) {
        if (sample.length >= SAMPLE_LIMIT) break;
        sample.push({ code: o.code, trackingCode: o.tracking_codes, carrier: o.carriers, shippedAt: new Date(o.shipped_at).toISOString() });
      }

      const orderIds = due.map((o) => o.id);

      if (apply) {
        // Single batched UPDATE: every Shipped fulfillment of every claimed
        // order in one statement, not a per-row loop — one round-trip, one
        // lock-pass, and a concurrent pass cannot slip a duplicate update in
        // between because the order rows are still locked at txn commit. Plain
        // array interpolation into the sql template renders `IN (uuid1, uuid2, ...)`
        // (drizzle expands bare arrays into a LIST TO EXPAND; this is the same
        // form release-stale-allocations uses for its orderIds).
        await tx.execute(
          sql`UPDATE fulfillment
              SET state = 'Delivered', updated_at = now()
              WHERE order_id IN ${orderIds} AND state = 'Shipped'`,
        );
        // Single batched audit insert: one row per claimed order, all
        // attached to the same txn so either the whole batch is auditable or
        // none of it is.
        await tx.insert(s.auditLog).values(
          due.map((o) => ({
            storeId,
            actor: 'system:auto-deliver',
            entity: 'order',
            entityId: o.id,
            action: 'auto_delivered',
            toState: 'Delivered',
            data: { days },
          })),
        );
      }

      return due.length;
    });
    count += n;
    // Dry runs never change state, so a second pass would re-claim the same rows.
    if (!apply || n < limit) break;
  }

  if (!apply && opts.exact) {
    count = await withStore(storeId, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int AS n FROM "order" o WHERE ${candidateWhere(storeId, cutoff)}`);
      return Math.min((r as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0, maxOrders);
    });
  }
  return { count, sample, days, cutoff: cutoff.toISOString(), apply };
}

/**
 * One idempotent pass: mark Shipped fulfillments older than `days` as Delivered.
 * Reusable from the CLI wrapper or the scheduler. Caller owns the pool lifecycle.
 */
export async function autoDeliver(opts: AutoDeliverOpts): Promise<number> {
  const { apply, days } = opts;
  const log = opts.log ?? (() => {});
  assertDays(days);
  const cutoff = new Date(Date.now() - days * 86_400_000);
  log(`[auto-deliver] mode=${apply ? 'APPLY' : 'DRY-RUN'} days=${days} cutoff=${cutoff.toISOString()}`);

  const stores = await pool.query<{ id: string; slug: string }>('SELECT id, slug FROM store');
  let total = 0;

  for (const st of stores.rows) {
    const { count: n } = await autoDeliverStore(st.id, { apply, days, batchLimit: opts.batchLimit, maxOrders: opts.maxOrders });
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