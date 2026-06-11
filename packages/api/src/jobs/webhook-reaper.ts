/**
 * Webhook reaper (WP1.7 follow-up). The scheduler claims rows by flipping
 * `pending → processing` in a transaction; if the process crashes mid-delivery
 * the row stays `processing` forever and the delivery is lost. This job
 * resets stuck `processing` rows back to `pending` after a grace period, so
 * the next scheduler pass re-claims and retries.
 *
 * Why a separate job (and not a timeout in the scheduler itself): the scheduler
 * uses a row lock + the processing flag; if the worker holding the lock dies,
 * Postgres releases the lock, but the flag stays set. A reaper that runs
 * independently is the only way to recover. Runs as the OWNER role.
 *
 * Schedule: every 5 minutes (the grace period is 10 min, so a crashed worker
 * is reset within 10–15 min of death).
 *
 * Usage:
 *   tsx src/jobs/webhook-reaper.ts            # DRY RUN
 *   GRACE_MIN=10 tsx src/jobs/webhook-reaper.ts --apply
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';

export type ReaperOpts = { apply: boolean; graceMin: number; log?: (m: string) => void };

/** One idempotent pass: reset stuck 'processing' webhook rows back to 'pending'. */
export async function reapStuckWebhooks(opts: ReaperOpts): Promise<{ reset: number }> {
  const { apply, graceMin } = opts;
  const log = opts.log ?? (() => {});
  if (!Number.isFinite(graceMin) || graceMin <= 0) throw new Error('graceMin must be a positive number');
  const cutoff = new Date(Date.now() - graceMin * 60_000);
  log(`[webhook-reaper] mode=${apply ? 'APPLY' : 'DRY-RUN'} grace=${graceMin}min cutoff=${cutoff.toISOString()}`);

  const stores = await pool.query<{ id: string; slug: string }>('SELECT id, slug FROM store');
  let total = 0;
  for (const st of stores.rows) {
    const n = await withStore(st.id, async (tx) => {
      if (!apply) {
        // DRY-RUN: count only, do NOT mutate. Mirrors the semantics of
        // release-stale-allocations and auto-deliver so --apply is the only
        // path that writes.
        // webhook_delivery has no updatedAt (only createdAt + deliveredAt +
        // nextAttemptAt). createdAt is the stuck-since marker: a row is stuck
        // if it's been 'processing' since creation past the grace window.
        const [r] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(s.webhookDelivery)
          .where(and(eq(s.webhookDelivery.status, 'processing'), lt(s.webhookDelivery.createdAt, cutoff)));
        return r?.n ?? 0;
      }
      // APPLY: reset stuck rows back to 'pending' so the scheduler retries.
      // Parameterized interval — no SQL injection from the env var.
      const due = await tx
        .update(s.webhookDelivery)
        .set({
          status: 'pending',
          lastError: sql`coalesce(${s.webhookDelivery.lastError}, '') || ${` [reaped after ${graceMin}m stuck]`}`,
        })
        .where(and(eq(s.webhookDelivery.status, 'processing'), lt(s.webhookDelivery.createdAt, cutoff)))
        .returning({ id: s.webhookDelivery.id });
      return due.length;
    });
    total += n;
    if (n) log(`[webhook-reaper] ${st.slug}: ${apply ? 'reset' : 'would reset'} ${n}`);
  }
  log(`[webhook-reaper] done: ${total}${apply ? '' : ' (DRY RUN — --apply to act)'}`);
  return { reset: total };
}

const isCli = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('webhook-reaper.ts');
if (isCli) {
  reapStuckWebhooks({ apply: process.argv.includes('--apply'), graceMin: Number(process.env.GRACE_MIN ?? 10), log: (m) => console.log(m) })
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
