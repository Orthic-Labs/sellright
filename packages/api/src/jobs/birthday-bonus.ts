/**
 * REWARDS-1: birthday bonus sweep. Cross-store shape matches
 * sheeridExpirySweep: enumerate stores on the owner pool, then per-store work
 * inside withStore. Idempotent (source_ref carries the year), so an hourly
 * cadence only changes how soon after midnight UTC the bonus appears.
 */
import { pool, withStore } from '../db/client.js';
import { grantBirthdayBonuses } from '../loyalty/bonus.js';

export async function birthdayBonusSweep(opts: { log?: (m: string) => void; now?: Date } = {}): Promise<{ granted: number }> {
  const log = opts.log ?? (() => {});
  const stores = await pool.query<{ id: string }>('SELECT id FROM store');
  let granted = 0;
  for (const st of stores.rows) granted += await withStore(st.id, (tx) => grantBirthdayBonuses(tx, st.id, opts.now));
  if (granted) log(`[birthday-bonus] granted=${granted}`);
  return { granted };
}
