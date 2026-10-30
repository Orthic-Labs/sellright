/**
 * REWARDS-1: birthday bonus sweep. Cross-store shape matches
 * sheeridExpirySweep: enumerate stores on the owner pool, then per-store work
 * inside withStore. Idempotent (source_ref carries the year), so an hourly
 * cadence only changes how soon after midnight UTC the bonus appears.
 *
 * D6 (perf plan P6): each batch of BIRTHDAY_BATCH customers commits in its own
 * short transaction instead of the whole day's population sharing one. The
 * existing NOT EXISTS exclusion is unchanged, so a crash between batches leaves
 * committed grants in place and the next batch/pass simply skips them; one
 * `now` is used for the whole pass so every batch targets the same day/year.
 */
import { pool, withStore } from '../db/client.js';
import { grantBirthdayBonusBatch } from '../loyalty/bonus.js';

export async function birthdayBonusSweep(opts: { log?: (m: string) => void; now?: Date; batchLimit?: number } = {}): Promise<{ granted: number }> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const stores = await pool.query<{ id: string }>('SELECT id FROM store');
  let granted = 0;
  for (const st of stores.rows) {
    let after: string | null = null;
    do {
      const cursor: string | null = after;
      const batch: { granted: number; next: string | null } = await withStore(st.id, (tx) => grantBirthdayBonusBatch(tx, st.id, now, cursor, opts.batchLimit));
      granted += batch.granted;
      after = batch.next;
    } while (after);
  }
  if (granted) log(`[birthday-bonus] granted=${granted}`);
  return { granted };
}
