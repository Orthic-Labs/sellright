/**
 * Single-leader guard for the setInterval job scheduler (OPS-2). The scheduler's
 * `running` flag in scheduler.ts only prevents intra-process overlap — it has no
 * cross-process coordination. Run two API instances (blue/green deploy, a stray
 * second process) and BOTH fire every job tick against the same DB. For a job
 * that isn't (yet) written to tolerate concurrent execution — e.g. the old
 * per-line-loop release-stale-allocations — that means the SAME stock release
 * is applied twice: real, silent inventory corruption.
 *
 * Fix: a Postgres session-level advisory lock. `pg_try_advisory_lock` is
 * non-blocking — the caller either becomes leader for this tick or backs off
 * immediately (no queueing, no thundering herd). Advisory locks are tied to the
 * *session* (the physical connection), NOT a transaction, so we must acquire and
 * release on the SAME `PoolClient` — never `pool.query()`, which hands back a
 * different connection per call and would try to unlock a lock some other
 * client holds (a silent no-op, not an error).
 */
import { pool } from '../db/client.js';

/**
 * Stable per-job advisory lock keys. `pg_try_advisory_lock(bigint)` takes a
 * single 64-bit key; we mint one per job name from a fixed namespace so
 * unrelated jobs never contend with each other, and the key is stable across
 * process restarts / deploys (it's derived from the literal job name, not a
 * random or environment-dependent value).
 *
 * Namespace: high 32 bits = 0x53525350 ("SRSP" — SellRight Scheduler), low 32
 * bits = a small per-job index. Kept in one map so every leader-locked job is
 * visible at a glance and two jobs can never accidentally collide on the same
 * key.
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
} as const satisfies Record<string, bigint>;

export type LeaderLockedJob = keyof typeof JOB_KEYS;

/**
 * Run `fn` only if this process wins the advisory lock for `job`. If another
 * instance already holds it, this is a no-op (the caller is not the leader for
 * this tick) — that instance's own tick already covers the work. Acquire +
 * release happen on one dedicated client for the lock's lifetime; `fn` itself
 * still uses the shared `pool`/`withStore` for its actual queries.
 */
export async function withLeaderLock<T>(job: LeaderLockedJob, fn: () => Promise<T>): Promise<T | undefined> {
  const key = JOB_KEYS[job];
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    if (!rows[0]?.locked) return undefined; // another instance is leader for this tick — skip
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
}
