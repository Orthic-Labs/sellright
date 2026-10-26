/**
 * Single-leader guard for the job scheduler (OPS-2). The scheduler's in-process
 * `running` flag only prevents overlap inside one process. Run two API
 * instances (blue/green deploy, a stray second process) and BOTH would fire
 * every job tick against the same DB — for a job not written to tolerate
 * concurrent execution that means the SAME stock release applied twice.
 *
 * Leadership is a row in `scheduler_lease` (migration 0112, #358): one short
 * INSERT … ON CONFLICT claims the job's name when nobody holds it (or the
 * holder's lease has expired), a timer renews it while the pass runs, and a
 * DELETE gives it back. Each acquisition has its own random token, so a nested
 * claim of the same name in the same process is refused exactly like a second
 * process. The statements run on the small locks pool (db/client.ts) and no
 * connection is held between them — the previous session advisory lock pinned
 * one pooled connection idle for the whole pass, which is how the hourly tick
 * exhausted the request pool (#358 / #360). A crashed holder is released when
 * its lease expires (LEASE_TTL_MS) instead of when its TCP session dies.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { LeaseLostError, locksPool, runWithLeaseFence, type LeaseFence } from '../db/client.js';
import { err as logErr } from '../lib/logger.js';

/** A holder that stops renewing (crash, frozen event loop) loses the lease after this long. */
export const LEASE_TTL_MS = 60_000;
/** Renewal cadence: three chances to renew before the lease can lapse. */
export const LEASE_RENEW_MS = 15_000;
let timing = { ttlMs: LEASE_TTL_MS, renewMs: LEASE_RENEW_MS };

/** Test-only: shorten the lease term and renewal cadence (null restores the defaults). */
export function _setLeaseTimingForTest(t: { ttlMs: number; renewMs: number } | null): void {
  timing = t ?? { ttlMs: LEASE_TTL_MS, renewMs: LEASE_RENEW_MS };
}
const HOLDER = `${hostname()}:${process.pid}`;

/**
 * The registry of engine leader-locked jobs: one entry per job name, so every
 * leader-locked job is visible at a glance. The lease row is keyed by the name
 * itself (plus `:<scope>` for per-store publishers). The numeric values are the
 * advisory-lock keys of the pre-0112 scheme, kept so this list stays the single
 * record of which numbers that scheme used.
 */
const NAMESPACE = 0x53525350n << 32n;
const JOB_KEYS = {
  'release-stale': NAMESPACE | 1n,
  'auto-deliver': NAMESPACE | 2n,
  'cart-maintenance': NAMESPACE | 3n,
  webhooks: NAMESPACE | 4n,
  'webhook-reaper': NAMESPACE | 5n,
  emails: NAMESPACE | 6n,
  push: NAMESPACE | 7n,
  // SUBSCRIBER-1: claims confirmed + unsynced subscriber rows and pushes them
  // to Listmonk. Same shape as emails/webhooks — best-effort, retryable, no
  // request-path dependency.
  'listmonk-sync': NAMESPACE | 8n,
  // processed_event never had a reaper before; batched-delete pass, same
  // leader-locked shape as webhook-reaper.
  'processed-event-reaper': NAMESPACE | 9n,
  'gateway-events': NAMESPACE | 10n,
  // PAR-4: SheerID verification expiry sweep (sheerid-expiry.ts).
  'sheerid-expiry': NAMESPACE | 11n,
  // PAR-5: drains stock-trigger restock events into one-shot notifications
  // (routes/restock.ts sweepRestockEvents).
  'restock-notify': NAMESPACE | 12n,
  'catalog-manifest': NAMESPACE | 13n,
  // SELLRIGHT-ISSUES P1: retention cleanup for the shared rate-limit backend's
  // rate_limit_attempt table (auth/rate-limit-backend.ts).
  'rate-limit-reaper': NAMESPACE | 14n,
  // SELLRIGHT-ISSUES P1: durable-retry drain for catalog_manifest_pending
  // (manifest/manifest-pending.ts).
  'catalog-manifest-drain': NAMESPACE | 15n,
  // Payments D7/D8: stuck NMI/Sezzle attempt auto-verification
  // (jobs/gateway-recovery.ts). 20 leaves room for parallel lanes' keys.
  'gateway-recovery': NAMESPACE | 20n,
  // REWARDS-1: annual birthday bonus sweep (jobs/birthday-bonus.ts).
  'birthday-bonus': NAMESPACE | 30n,
  // De-fork 2.8: pending-effects drain (payments/settlement/effects.ts runEffectsPass).
  'pending-effects': NAMESPACE | 40n,
  // PAYMENT-TIMING §5.2 safety net: requested reservation releases and failed R5 projections (jobs/reservation-release-sweep.ts).
  'reservation-release-sweep': NAMESPACE | 41n,
  // Passkeys (0108): expired ceremony/grant rows (jobs/passkey-prune.ts).
  'passkey-prune': NAMESPACE | 42n,
  // #374: deletes Cancelled, money-free orders after the retention window (jobs/purge-cancelled-orders.ts).
  'purge-cancelled': NAMESPACE | 43n,
} as const satisfies Record<string, bigint>;

export type EngineLeaderLockedJob = keyof typeof JOB_KEYS;
/** Plugin jobs (plan 2.1 `jobs` phase) lock under `plugin:<name>`, hashed into the same advisory-lock space. */
export type PluginLeaderLockedJob = `plugin:${string}`;
export type LeaderLockedJob = EngineLeaderLockedJob | PluginLeaderLockedJob;

/** The pre-0112 advisory-lock key of a job (and scope), so a lease is never claimed while an old-protocol runner holds
 *  that lock (#360 N11). `hashed` keys went through hashtextextended(text, 0); the rest are the literal bigint. */
export function legacyAdvisoryKey(job: LeaderLockedJob, scope?: string): { key: string; hashed: boolean } {
  const isPluginJob = job.startsWith('plugin:');
  const base = isPluginJob ? `${NAMESPACE}:${job}` : String(JOB_KEYS[job as EngineLeaderLockedJob]);
  return scope === undefined && !isPluginJob ? { key: base, hashed: false } : { key: scope === undefined ? base : `${base}:${scope}`, hashed: true };
}

/**
 * Run `fn` only if this process wins the lease for `job` (and `scope`, for
 * per-store publishers). If another holder has it, this is a no-op (undefined):
 * that holder's own pass already covers the work. `fn` runs with no connection
 * held for the lease; its own queries use the pools as usual.
 *
 * Fencing (#360 N2): `fn` runs inside the lease's fence, so every store
 * transaction it opens re-checks the lease (row-locked) right before COMMIT and
 * rolls back if the lease expired or changed hands. Renewal that finds the lease
 * gone, or that has not succeeded for a whole TTL, marks it lost and aborts the
 * fence's signal (currentLeaseSignal() in db/client.ts) for work that can stop.
 *
 * Rollout (#360 N11): the claim is refused while an old-protocol runner (pre-0112
 * image) holds this job's advisory lock. An old runner does not see leases, so
 * the release order still matters: stop the old API before the new one starts,
 * and stop the new one before a rollback starts the old one.
 */
export async function withLeaderLock<T>(job: LeaderLockedJob, fn: () => Promise<T>, scope?: string): Promise<T | undefined> {
  if (!job.startsWith('plugin:') && !(job in JOB_KEYS)) throw new Error(`unknown leader-locked job: ${job}`);
  const name = scope === undefined ? job : `${job}:${scope}`;
  const token = randomUUID();
  const legacy = legacyAdvisoryKey(job, scope);
  const claimed = await locksPool.query(
    `WITH legacy AS (SELECT CASE WHEN $6::boolean THEN hashtextextended($5, 0) ELSE $5::bigint END AS k)
     INSERT INTO scheduler_lease AS l (name, token, holder, expires_at)
     SELECT $1, $2, $3, now() + make_interval(secs => $4::double precision / 1000)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_locks, legacy
       WHERE locktype = 'advisory' AND objsubid = 1
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND classid = ((legacy.k >> 32) & 4294967295)::oid AND objid = (legacy.k & 4294967295)::oid)
     ON CONFLICT (name) DO UPDATE SET token = EXCLUDED.token, holder = EXCLUDED.holder,
       acquired_at = now(), expires_at = EXCLUDED.expires_at
     WHERE l.expires_at <= now()
     RETURNING l.token`,
    [name, token, HOLDER, timing.ttlMs, legacy.key, legacy.hashed],
  );
  if (!claimed.rowCount) return undefined; // another holder leads this tick — skip
  const abort = new AbortController();
  const fence: LeaseFence = { name, token, lost: false, released: false, signal: abort.signal };
  const { ttlMs, renewMs } = timing;
  const markLost = (why: string) => {
    if (fence.lost || fence.released) return; // a renewal racing the pass's own release is not a loss (#360 L2)
    fence.lost = true;
    abort.abort(new LeaseLostError(name));
    logErr.error('scheduler lease lost while the pass is still running; its further commits are refused', undefined, { lease: name, why });
  };
  let renewedAt = Date.now();
  const renew = setInterval(() => {
    if (Date.now() - renewedAt > ttlMs) markLost('renewal has not succeeded for a whole lease term');
    void locksPool.query(
      'UPDATE scheduler_lease SET expires_at = now() + make_interval(secs => $3::double precision / 1000) WHERE name = $1 AND token = $2 AND expires_at > clock_timestamp()',
      [name, token, ttlMs],
    ).then((r) => {
      if (r.rowCount) renewedAt = Date.now();
      else markLost('the lease row expired or was taken over');
    }, (e) => { if (!fence.released) logErr.error('scheduler lease renewal failed (retrying)', e, { lease: name }); });
  }, renewMs);
  renew.unref();
  try {
    return await runWithLeaseFence(fence, fn);
  } finally {
    clearInterval(renew);
    // Before the DELETE: work this pass left running (it should have detached) may commit after the release, and a
    // renewal already in flight must not report a loss (#360 H1, L2).
    fence.released = true;
    await locksPool.query('DELETE FROM scheduler_lease WHERE name = $1 AND token = $2', [name, token])
      .catch((e) => logErr.error('scheduler lease release failed (it expires on its own)', e, { lease: name }));
  }
}
