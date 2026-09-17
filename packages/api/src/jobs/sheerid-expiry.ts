/**
 * PAR-04: SheerID verification expiry sweep (scheduler pass).
 *
 * Rows in sheerid_verification carry expires_at; customers' coupon-facing
 * active_verifications are recomputed from those rows. The read paths already
 * filter expired entries lazily (recompute drops expiresAt <= now), so this
 * job is the durable correction: it flips stale 'success' rows to 'expired'
 * and recomputes each affected customer, so eligibility can't linger if the
 * only signal was a row nobody re-read.
 *
 * Cross-store shape matches listmonkSync: enumerate stores on the owner pool,
 * then per-store work inside withStore (RLS context).
 */
import { pool, withStore } from '../db/client.js';
import { sweepExpiredVerifications } from '../sheerid/service.js';

export async function sheeridExpirySweep(opts: { log?: (m: string) => void } = {}): Promise<{ expired: number }> {
  const log = opts.log ?? (() => {});
  const stores = await pool.query<{ id: string }>('SELECT id FROM store');
  let expired = 0;
  for (const st of stores.rows) {
    const { expired: n } = await withStore(st.id, (tx) => sweepExpiredVerifications(tx, st.id));
    expired += n;
  }
  if (expired) log(`[sheerid-expiry] expired=${expired}`);
  return { expired };
}
