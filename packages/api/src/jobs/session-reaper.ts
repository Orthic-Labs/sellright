/**
 * session reaper (DB-M1 / DB-L3). Sessions were deleted only on logout, password change, erasure and admin
 * revocation, so expired rows (token hashes) accumulated with no retention rule.
 *
 * Deletes (a) rows whose `expires_at` is more than `graceDays` (default 7) in the past, and (b) legacy-imported rows
 * past `legacy_expires_at` (those can no longer authenticate: auth/session.ts requires the legacy expiry to be in the
 * future). Rows still valid, or expired for less than the grace window, are never touched.
 *
 * `session` is an RLS-exempt global table (db/assert-force-rls.ts: auth looks sessions up by token hash before any
 * store is chosen), so one global pass runs through an anchor store's lease-fenced transaction exactly like
 * processed-event-reaper.ts; the predicate alone selects rows. Batched, oldest first, SKIP LOCKED, with a per-run
 * batch cap so a backlog spreads over hourly runs. Dependent rows cascade (admin_device_token, admin_handoff_code,
 * ...) or are set null (migration session link) by their foreign keys.
 *
 * Uses the indexes from migration 0120 (session_expires_at_idx).
 */
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';

export type SessionReaperOpts = {
  apply: boolean;
  /** How long past `expires_at` a row is kept before deletion. */
  graceDays?: number;
  log?: (m: string) => void;
  batchLimit?: number;
};

export const SESSION_REAPER_GRACE_DAYS = 7;
const DEFAULT_BATCH_LIMIT = 1000;
const MAX_BATCHES_PER_RUN = 50;

/** One idempotent pass. Returns how many rows were (or, dry-run, would be) deleted. */
export async function reapSessions(opts: SessionReaperOpts): Promise<{ deleted: number }> {
  const { apply } = opts;
  const graceDays = opts.graceDays ?? SESSION_REAPER_GRACE_DAYS;
  const log = opts.log ?? (() => {});
  const batchLimit = opts.batchLimit && opts.batchLimit > 0 ? Math.floor(opts.batchLimit) : DEFAULT_BATCH_LIMIT;
  if (!Number.isFinite(graceDays) || graceDays <= 0) throw new Error('graceDays must be a positive number');
  const cutoff = new Date(Date.now() - graceDays * 24 * 3_600_000);
  const now = new Date();
  log(`[session-reaper] mode=${apply ? 'APPLY' : 'DRY-RUN'} grace=${graceDays}d cutoff=${cutoff.toISOString()}`);

  const anchor = (await pool.query<{ id: string }>('SELECT id FROM store ORDER BY id LIMIT 1')).rows[0]?.id;
  let total = 0;
  for (let batches = 0; anchor && batches < MAX_BATCHES_PER_RUN; batches++) {
    if (!apply) {
      total = await withStore(anchor, async (tx) => {
        const r = await tx.execute(sql`SELECT count(*)::int AS n FROM session
          WHERE expires_at < ${cutoff} OR legacy_expires_at < ${now}`);
        return (r.rows[0] as { n: number } | undefined)?.n ?? 0;
      });
      break; // dry-run never loops
    }
    const n = await withStore(anchor, async (tx) => {
      const r = await tx.execute(sql`DELETE FROM session WHERE id IN (
          SELECT id FROM session
          WHERE expires_at < ${cutoff} OR legacy_expires_at < ${now}
          ORDER BY expires_at, id LIMIT ${batchLimit} FOR UPDATE SKIP LOCKED)
        RETURNING id`);
      return r.rows.length;
    });
    total += n;
    if (n < batchLimit) break;
  }
  log(`[session-reaper] done: ${total}${apply ? '' : ' (DRY RUN)'}`);
  return { deleted: total };
}
