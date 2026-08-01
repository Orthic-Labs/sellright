/**
 * processed_event reaper. `processed_event` gets one row per inbound Stripe
 * webhook id (payment-webhooks.ts) and one row per payment idempotency claim
 * (pay.ts) — both write via `insert ... onConflictDoNothing` style dedup keyed
 * on the provider event id, and NEITHER path ever deletes the row. With no
 * reaper, the table grows forever.
 *
 * Retention default is intentionally much longer than the idempotency window
 * a caller might reasonably expect (Stripe's own webhook retry window is a
 * few days) — 30 days gives a wide safety margin so an old-but-still-inflight
 * retry can never be double-processed by this reaper accidentally reopening
 * the door to a replay. Rows newer than the retention window are NEVER
 * touched, by construction (see the `lt(processedAt, cutoff)` predicate
 * below) — idempotency correctness for in-window events is unaffected.
 *
 * Mirrors the webhook-reaper.ts pattern: idempotent pass, per-store loop
 * (RLS via withStore), DRY-RUN by default, batched deletes so a large backlog
 * doesn't take one giant table lock. Runs as the OWNER role.
 *
 * Usage:
 *   tsx src/jobs/processed-event-reaper.ts                # DRY RUN
 *   RETENTION_DAYS=30 tsx src/jobs/processed-event-reaper.ts --apply
 */
import { inArray, lt, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';

export type ProcessedEventReaperOpts = {
  apply: boolean;
  retentionDays: number;
  log?: (m: string) => void;
  batchLimit?: number;
};

const DEFAULT_BATCH_LIMIT = 1000;

/** One idempotent pass: delete processed_event rows older than the retention window. */
export async function reapProcessedEvents(opts: ProcessedEventReaperOpts): Promise<{ deleted: number }> {
  const { apply, retentionDays } = opts;
  const log = opts.log ?? (() => {});
  const batchLimit = opts.batchLimit && opts.batchLimit > 0 ? Math.floor(opts.batchLimit) : DEFAULT_BATCH_LIMIT;
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error('retentionDays must be a positive number');
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3_600_000);
  log(`[processed-event-reaper] mode=${apply ? 'APPLY' : 'DRY-RUN'} retention=${retentionDays}d cutoff=${cutoff.toISOString()}`);

  const stores = await pool.query<{ id: string; slug: string }>('SELECT id, slug FROM store');
  let total = 0;
  for (const st of stores.rows) {
    let storeDeleted = 0;
    // Batched loop: each pass deletes at most `batchLimit` rows so a large
    // backlog never takes one giant table lock. Repeats until a batch comes
    // back short (nothing left older than cutoff for this store).
    for (;;) {
      const n = await withStore(st.id, async (tx) => {
        if (!apply) {
          const [r] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(s.processedEvent)
            .where(lt(s.processedEvent.processedAt, cutoff));
          return r?.n ?? 0;
        }
        // Claim a batch of ids first, then delete by id — avoids a DELETE
        // statement with its own ORDER BY/LIMIT (not portable across drizzle
        // query builders) while still bounding each pass to `batchLimit` rows.
        const claimed = await tx
          .select({ id: s.processedEvent.id })
          .from(s.processedEvent)
          .where(lt(s.processedEvent.processedAt, cutoff))
          .limit(batchLimit);
        if (!claimed.length) return 0;
        const deleted = await tx
          .delete(s.processedEvent)
          .where(inArray(s.processedEvent.id, claimed.map((r) => r.id)))
          .returning({ id: s.processedEvent.id });
        return deleted.length;
      });
      storeDeleted += n;
      if (!apply || n < batchLimit) break; // dry-run never loops; apply stops once a batch comes back short
    }
    total += storeDeleted;
    if (storeDeleted) log(`[processed-event-reaper] ${st.slug}: ${apply ? 'deleted' : 'would delete'} ${storeDeleted}`);
  }
  log(`[processed-event-reaper] done: ${total}${apply ? '' : ' (DRY RUN — --apply to act)'}`);
  return { deleted: total };
}

const isCli = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('processed-event-reaper.ts');
if (isCli) {
  reapProcessedEvents({ apply: process.argv.includes('--apply'), retentionDays: Number(process.env.RETENTION_DAYS ?? 30), log: (m) => console.log(m) })
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
