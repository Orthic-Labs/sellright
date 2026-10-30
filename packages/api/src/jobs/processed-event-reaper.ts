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
 * Idempotent pass, DRY-RUN by default, batched deletes so a large backlog
 * doesn't take one giant table lock. One global pass (the table has no RLS
 * and no per-store scoping; see D3 below).
 *
 * Usage:
 *   tsx src/jobs/processed-event-reaper.ts                # DRY RUN
 *   RETENTION_DAYS=30 tsx src/jobs/processed-event-reaper.ts --apply
 */
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';

export type ProcessedEventReaperOpts = {
  apply: boolean;
  retentionDays: number;
  log?: (m: string) => void;
  batchLimit?: number;
};

const DEFAULT_BATCH_LIMIT = 1000;
const MAX_BATCHES_PER_RUN = 50;

/** One idempotent pass: delete processed_event rows older than the retention window. */
export async function reapProcessedEvents(opts: ProcessedEventReaperOpts): Promise<{ deleted: number }> {
  const { apply, retentionDays } = opts;
  const log = opts.log ?? (() => {});
  const batchLimit = opts.batchLimit && opts.batchLimit > 0 ? Math.floor(opts.batchLimit) : DEFAULT_BATCH_LIMIT;
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error('retentionDays must be a positive number');
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3_600_000);
  log(`[processed-event-reaper] mode=${apply ? 'APPLY' : 'DRY-RUN'} retention=${retentionDays}d cutoff=${cutoff.toISOString()}`);

  // D3 (perf plan P6): processed_event is an explicitly GLOBAL table (no RLS;
  // drizzle/0001_rls_policies.sql) keyed by provider event id. The old per-store
  // loop ran the same unscoped count/delete once per store. One global pass now,
  // with a per-run batch cap so a large backlog spreads across hourly runs.
  // Replay protection is unchanged: only rows older than the retention window
  // are ever touched, and APPLY stays default OFF (scheduler flag).
  //
  // Statements still run through withStore so every delete commits inside the
  // lease-fenced store transaction wrapper (runner protocol: an expired leader
  // cannot commit). The anchor store only supplies that wrapper; the table has
  // no RLS, so the predicate alone selects rows, exactly as before.
  const anchor = (await pool.query<{ id: string }>('SELECT id FROM store ORDER BY id LIMIT 1')).rows[0]?.id;
  let total = 0;
  for (let batches = 0; anchor && batches < MAX_BATCHES_PER_RUN; batches++) {
    if (!apply) {
      total = await withStore(anchor, async (tx) => {
        const r = await tx.execute(sql`SELECT count(*)::int AS n FROM processed_event WHERE processed_at < ${cutoff}`);
        return (r.rows[0] as { n: number } | undefined)?.n ?? 0;
      });
      break; // dry-run never loops
    }
    const n = await withStore(anchor, async (tx) => {
      const r = await tx.execute(sql`DELETE FROM processed_event WHERE id IN (
          SELECT id FROM processed_event WHERE processed_at < ${cutoff}
          ORDER BY processed_at, id LIMIT ${batchLimit} FOR UPDATE SKIP LOCKED)
        RETURNING id`);
      return r.rows.length;
    });
    total += n;
    if (n < batchLimit) break; // apply stops once a batch comes back short
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
