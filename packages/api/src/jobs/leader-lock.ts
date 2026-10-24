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
import { locksPool } from '../db/client.js';
import { err as logErr } from '../lib/logger.js';

/** A holder that stops renewing (crash, frozen event loop) loses the lease after this long. */
export const LEASE_TTL_MS = 60_000;
/** Renewal cadence: three chances to renew before the lease can lapse. */
export const LEASE_RENEW_MS = 15_000;
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
} as const satisfies Record<string, bigint>;

export type EngineLeaderLockedJob = keyof typeof JOB_KEYS;
/** Plugin jobs (plan 2.1 `jobs` phase) lock under `plugin:<name>`, hashed into the same advisory-lock space. */
export type PluginLeaderLockedJob = `plugin:${string}`;
export type LeaderLockedJob = EngineLeaderLockedJob | PluginLeaderLockedJob;

/**
 * Run `fn` only if this process wins the lease for `job` (and `scope`, for
 * per-store publishers). If another holder has it, this is a no-op (undefined):
 * that holder's own pass already covers the work. `fn` runs with no connection
 * held for the lease; its own queries use the pools as usual.
 */
export async function withLeaderLock<T>(job: LeaderLockedJob, fn: () => Promise<T>, scope?: string): Promise<T | undefined> {
  if (!job.startsWith('plugin:') && !(job in JOB_KEYS)) throw new Error(`unknown leader-locked job: ${job}`);
  const name = scope === undefined ? job : `${job}:${scope}`;
  const token = randomUUID();
  const claimed = await locksPool.query(
    `INSERT INTO scheduler_lease AS l (name, token, holder, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision / 1000))
     ON CONFLICT (name) DO UPDATE SET token = EXCLUDED.token, holder = EXCLUDED.holder,
       acquired_at = now(), expires_at = EXCLUDED.expires_at
     WHERE l.expires_at <= now()
     RETURNING l.token`,
    [name, token, HOLDER, LEASE_TTL_MS],
  );
  if (!claimed.rowCount) return undefined; // another holder leads this tick — skip
  let lost = false;
  const renew = setInterval(() => {
    void locksPool.query(
      'UPDATE scheduler_lease SET expires_at = now() + make_interval(secs => $3::double precision / 1000) WHERE name = $1 AND token = $2',
      [name, token, LEASE_TTL_MS],
    ).then((r) => {
      if (!r.rowCount && !lost) {
        lost = true;
        logErr.error('scheduler lease lost while the pass is still running', undefined, { lease: name });
      }
    }, (e) => logErr.error('scheduler lease renewal failed (retrying)', e, { lease: name }));
  }, LEASE_RENEW_MS);
  renew.unref();
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await locksPool.query('DELETE FROM scheduler_lease WHERE name = $1 AND token = $2', [name, token])
      .catch((e) => logErr.error('scheduler lease release failed (it expires on its own)', e, { lease: name }));
  }
}
