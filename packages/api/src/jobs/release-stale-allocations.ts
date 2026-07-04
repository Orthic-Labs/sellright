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
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';

export type ReleaseStaleOpts = { apply: boolean; ttlMin: number; log?: (m: string) => void; batchLimit?: number };

const DEFAULT_BATCH_LIMIT = 200;

/**
 * One idempotent pass: cancel stale unpaid orders and release their stock
 * reservation. Reusable from the CLI wrapper (manual) or the scheduler. Does NOT
 * close the pool — the caller owns the pool lifecycle.
 */
export async function releaseStaleAllocations(opts: ReleaseStaleOpts): Promise<{ orders: number; released: number }> {
  const { apply, ttlMin } = opts;
  const log = opts.log ?? (() => {});
  const batchLimit = opts.batchLimit && opts.batchLimit > 0 ? Math.floor(opts.batchLimit) : DEFAULT_BATCH_LIMIT;
  if (!Number.isFinite(ttlMin) || ttlMin <= 0) throw new Error('ttlMin must be a positive number');
  const cutoff = new Date(Date.now() - ttlMin * 60_000);
  log(`[release-stale] mode=${apply ? 'APPLY' : 'DRY-RUN'} ttl=${ttlMin}min cutoff=${cutoff.toISOString()}`);

  const stores = await pool.query<{ id: string; slug: string }>('SELECT id, slug FROM store');
  let totalOrders = 0;
  let totalReleased = 0;

  for (const st of stores.rows) {
    const res = await withStore(st.id, async (tx) => {
      // Claim a batch under FOR UPDATE SKIP LOCKED: a concurrent pass (another
      // process that bypassed the leader lock, or an overlapping manual run)
      // skips any row already locked here instead of double-processing it.
      const claimed = await tx.execute(
        sql`SELECT id, code, created_at
            FROM "order"
            WHERE state = 'PendingPayment' AND created_at < ${cutoff} AND store_id = ${st.id}
            ORDER BY created_at
            LIMIT ${batchLimit}
            FOR UPDATE SKIP LOCKED`,
      );
      const stale = (claimed as unknown as { rows: Array<{ id: string; code: string; created_at: Date }> }).rows;
      if (!stale.length) return { count: 0, released: 0 };

      const orderIds = stale.map((o) => o.id);
      const lines = await tx
        .select({ orderId: s.orderLine.orderId, variantId: s.orderLine.variantId, quantity: s.orderLine.quantity, fulfilledQty: s.orderLine.fulfilledQty })
        .from(s.orderLine)
        .where(sql`${s.orderLine.orderId} IN ${orderIds}`);

      // Aggregate the release per variant BEFORE writing anything, so the
      // stock UPDATE is a single batched statement — one row touched at most
      // once per variant, not once per order line.
      const releaseByVariant = new Map<string, number>();
      let released = 0;
      for (const l of lines) {
        const rel = l.quantity - l.fulfilledQty;
        if (rel > 0 && l.variantId) {
          releaseByVariant.set(l.variantId, (releaseByVariant.get(l.variantId) ?? 0) + rel);
          released += rel;
        }
      }

      if (apply) {
        if (releaseByVariant.size) {
          const variantIds = [...releaseByVariant.keys()];
          const amounts = variantIds.map((id) => releaseByVariant.get(id)!);
          // Batched release: one UPDATE joined against the aggregated
          // (variant_id, amount) pairs via unnest() — not a query per line, and
          // not repeatable-double-subtract if this ever ran twice on the same
          // claimed set (each claimed order is cancelled in the same txn that
          // applied its release, so a retry only ever sees fresh orders).
          // sql.param() is required here (not a bare ${variantIds}) — drizzle's
          // sql`` tag treats a raw interpolated array as a LIST TO EXPAND, i.e.
          // `${variantIds}` renders as `($1, $2, $3)`, which turns
          // `unnest(($1,$2,$3)::uuid[])` into a row-expression cast, NOT a real
          // array literal. sql.param() forces it to bind as one array-valued
          // parameter ($1::uuid[]) instead, which is what unnest() needs.
          await tx.execute(
            sql`UPDATE stock
                SET allocated = greatest(allocated - v.amount, 0)
                FROM (SELECT * FROM unnest(${sql.param(variantIds)}::uuid[], ${sql.param(amounts)}::int[]) AS t(variant_id, amount)) AS v
                WHERE stock.variant_id = v.variant_id AND stock.store_id = ${st.id}`,
          );
        }
        await tx.execute(
          sql`UPDATE "order" SET state = 'Cancelled', updated_at = now() WHERE id IN ${orderIds}`,
        );
        await tx.insert(s.auditLog).values(
          stale.map((o) => ({
            storeId: st.id, actor: 'system:reservation-expiry', entity: 'order', entityId: o.id,
            action: 'cancel', fromState: 'PendingPayment', toState: 'Cancelled', data: { reason: 'stale_unpaid', ttlMin },
          })),
        );
      }

      return { count: stale.length, released };
    });
    totalOrders += res.count;
    totalReleased += res.released;
    if (res.count) log(`[release-stale] ${st.slug}: ${apply ? 'cancelled' : 'would cancel'} ${res.count} orders, ${apply ? 'released' : 'would release'} ${res.released} units`);
  }

  log(`[release-stale] done: ${totalOrders} orders, ${totalReleased} units${apply ? '' : ' (DRY RUN — re-run with --apply to act)'}`);
  return { orders: totalOrders, released: totalReleased };
}

// CLI entry: `tsx src/jobs/release-stale-allocations.ts [--apply]` (TTL_MINUTES env).
// Only runs when executed directly, not when imported by the scheduler.
const isCli = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('release-stale-allocations.ts');
if (isCli) {
  releaseStaleAllocations({ apply: process.argv.includes('--apply'), ttlMin: Number(process.env.TTL_MINUTES ?? 60), log: (m) => console.log(m) })
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
