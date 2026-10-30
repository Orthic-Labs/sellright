/**
 * Pluggable sliding-window rate-limit storage (SELLRIGHT-ISSUES P1 —
 * "Rate limiting is process-local"). auth/rate-limit.ts and the various
 * *.limit.ts throttles (contact, restock, newsletter, tracking, apps/
 * licensing) each kept their OWN per-process in-memory Map — safe for a
 * single API instance, silently ineffective across multiple: each process
 * gets its own independent budget, and a restart clears it. This module is
 * the one shared implementation of the sliding-window algorithm every one
 * of those callers now delegates to.
 *
 * Backend selection (RATE_LIMIT_BACKEND, see env.ts):
 *   'postgres' (default) — shared via the `rate_limit_attempt` table
 *     (migration 0078); every API process sees the same budget. No Redis —
 *     Postgres is the store's already-required dependency.
 *   'memory' — explicit single-process opt-out, same semantics as before
 *     this change. Also what the unit test lane uses (env.NODE_ENV==='test'
 *     with RATE_LIMIT_BACKEND unset), since it runs with no database.
 *
 * Every bucket (auth, contact, restock, newsletter, tracking, trial,
 * license, cart, ...) keeps its own window/cap and its own key namespace —
 * this module only supplies the storage + algorithm, never a shared
 * threshold, so tuning one surface still never changes another's allowance.
 *
 * Concurrency (Postgres backend): `consume` prunes, counts and inserts in one
 * transaction under a per-(bucket, key) advisory lock, so concurrent requests
 * (in any API process) cannot all observe "under cap". The in-memory backend
 * is atomic because each operation runs without an intervening await.
 */
import { pool } from '../db/client.js';
import { env } from '../env.js';

export interface RateLimitBackend {
  /** Prune, then report retryAfterSeconds (0 = allowed) — never records anything. */
  check(bucket: string, key: string, windowMs: number, maxAttempts: number): Promise<number>;
  /** Prune, then consume one attempt if under cap (recording it); else report retryAfterSeconds without recording. */
  consume(bucket: string, key: string, windowMs: number, maxAttempts: number): Promise<number>;
  /** Unconditionally record one attempt — no cap check (failure counters / two-step "record after the fact" callers). */
  recordFailure(bucket: string, key: string, windowMs: number): Promise<void>;
  /** Forget this bucket/key entirely (e.g. a successful login clearing prior failures). */
  clear(bucket: string, key: string): Promise<void>;
}

// ── in-memory backend ───────────────────────────────────────────────────────
interface Entry { attempts: number[]; windowMs: number; }

export function createMemoryRateLimitBackend(): RateLimitBackend {
  const store = new Map<string, Entry>();
  const k = (bucket: string, key: string) => `${bucket}\u0000${key}`;
  const prune = (e: Entry, now: number, windowMs: number) => {
    e.attempts = e.attempts.filter((t) => now - t < windowMs);
  };
  const retryFor = (e: Entry, now: number, windowMs: number, maxAttempts: number): number => {
    if (e.attempts.length < maxAttempts) return 0;
    const oldest = e.attempts[0]!;
    return Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
  };
  // Global cleanup prunes each entry by ITS OWN window (buckets mix 15-minute and 1-hour windows; pruning everything by
  // the triggering call's window would expire longer-window entries early).
  const cleanup = (now: number) => {
    if (store.size <= 5000) return;
    for (const [kk, e] of store) {
      prune(e, now, e.windowMs);
      if (!e.attempts.length) store.delete(kk);
    }
  };
  return {
    async check(bucket, key, windowMs, maxAttempts) {
      const e = store.get(k(bucket, key));
      if (!e) return 0;
      const now = Date.now();
      prune(e, now, windowMs);
      return retryFor(e, now, windowMs, maxAttempts);
    },
    async consume(bucket, key, windowMs, maxAttempts) {
      const mk = k(bucket, key);
      const e = store.get(mk) ?? { attempts: [], windowMs };
      e.windowMs = Math.max(e.windowMs, windowMs);
      const now = Date.now();
      prune(e, now, windowMs);
      const retry = retryFor(e, now, windowMs, maxAttempts);
      if (retry > 0) return retry;
      e.attempts.push(now);
      store.set(mk, e);
      cleanup(now);
      return 0;
    },
    async recordFailure(bucket, key, windowMs) {
      const mk = k(bucket, key);
      const e = store.get(mk) ?? { attempts: [], windowMs };
      e.windowMs = Math.max(e.windowMs, windowMs);
      const now = Date.now();
      prune(e, now, windowMs);
      e.attempts.push(now);
      store.set(mk, e);
      cleanup(now);
    },
    async clear(bucket, key) {
      store.delete(k(bucket, key));
    },
  };
}

// ── postgres backend ─────────────────────────────────────────────────────────
// Global infra table (no store_id, no RLS — same posture as session/
// processed_event; see rls-tables.test.ts's EXEMPT set). Queried via the
// unscoped owner `pool`, matching jobs/leader-lock.ts's own advisory-lock
// pattern for cross-cutting, non-tenant infra state.
//
// P8 (A6/G1, perf plan 2026-10-24): consume() used to hold a pooled client across BEGIN → pg_advisory_xact_lock (an
// unbounded server-side WAIT) → DELETE → SELECT → INSERT → COMMIT. A burst on one key (ten parallel cart reads, a
// login spray) parked one pool client per waiter, so the limiter itself could exhaust the request pool. Now:
//   - the lock is pg_try_advisory_xact_lock — never waits; a contended attempt commits immediately, RELEASES its client,
//     backs off in JS (no client held) and retries a bounded number of times, then fails CLOSED (deny, retry 1 s);
//   - once the lock is held, prune + count + conditional insert is ONE statement whose snapshot is taken after the lock
//     (READ COMMITTED: a new snapshot per statement), so a concurrent burst still cannot all observe "under cap" —
//     distributed enforcement across API processes is unchanged;
//   - check() / recordFailure() / clear() are single autocommit statements (no transaction, no lock).
const CONSUME_LOCK_TRIES = 6;
const CONSUME_BACKOFF_MS = [5, 10, 20, 40, 80];

const CONSUME_SQL = `WITH pruned AS (
  DELETE FROM rate_limit_attempt
   WHERE bucket = $1 AND key = $2 AND attempted_at < now() - ($3 || ' milliseconds')::interval
), cur AS (
  SELECT count(*)::int AS n, min(attempted_at) AS oldest
    FROM rate_limit_attempt
   WHERE bucket = $1 AND key = $2 AND attempted_at >= now() - ($3 || ' milliseconds')::interval
), ins AS (
  INSERT INTO rate_limit_attempt (bucket, key) SELECT $1, $2 FROM cur WHERE cur.n < $4::int RETURNING 1
)
SELECT cur.n, cur.oldest, EXISTS (SELECT 1 FROM ins) AS admitted FROM cur`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createPostgresRateLimitBackend(opts: { lockTries?: number; backoffMs?: readonly number[] } = {}): RateLimitBackend {
  const lockTries = Math.max(1, opts.lockTries ?? CONSUME_LOCK_TRIES);
  const backoff = opts.backoffMs ?? CONSUME_BACKOFF_MS;
  function retryFrom(oldest: Date | null, windowMs: number): number {
    if (!oldest) return 1;
    return Math.max(1, Math.ceil((windowMs - (Date.now() - oldest.getTime())) / 1000));
  }
  /** One non-blocking attempt: 'busy' when another request holds this key's lock right now. */
  async function consumeOnce(bucket: string, key: string, windowMs: number, maxAttempts: number): Promise<number | 'busy'> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: lockRows } = await client.query<{ got: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got', [`rate:${bucket}:${key}`],
      );
      if (!lockRows[0]?.got) { await client.query('COMMIT'); return 'busy'; }
      const { rows } = await client.query<{ n: number; oldest: Date | null; admitted: boolean }>(
        CONSUME_SQL, [bucket, key, String(windowMs), maxAttempts],
      );
      await client.query('COMMIT');
      const row = rows[0];
      if (row?.admitted) return 0;
      return retryFrom(row?.oldest ?? null, windowMs);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  return {
    async check(bucket, key, windowMs, maxAttempts) {
      // Read-only: expired rows are ignored by the time filter (pruning happens on the write paths and in the reaper).
      const { rows } = await pool.query<{ n: number; oldest: Date | null }>(
        `SELECT count(*)::int AS n, min(attempted_at) AS oldest FROM rate_limit_attempt
          WHERE bucket = $1 AND key = $2 AND attempted_at >= now() - ($3 || ' milliseconds')::interval`,
        [bucket, key, String(windowMs)],
      );
      const n = Number(rows[0]?.n ?? 0);
      return n < maxAttempts ? 0 : retryFrom(rows[0]?.oldest ?? null, windowMs);
    },
    async consume(bucket, key, windowMs, maxAttempts) {
      for (let i = 0; i < lockTries; i++) {
        const r = await consumeOnce(bucket, key, windowMs, maxAttempts);
        if (r !== 'busy') return r;
        if (i < lockTries - 1) {
          const base = backoff[Math.min(i, backoff.length - 1)] ?? 0;
          await sleep(base + Math.floor(Math.random() * (base + 1)));
        }
      }
      // Still contended after the bounded retries: fail closed. Only a same-key burst can get here, which is exactly
      // the traffic a limiter exists to refuse; the caller answers 429 with a 1 s retry.
      return 1;
    },
    async recordFailure(bucket, key, windowMs) {
      await pool.query(
        `WITH pruned AS (
           DELETE FROM rate_limit_attempt WHERE bucket = $1 AND key = $2 AND attempted_at < now() - ($3 || ' milliseconds')::interval
         ) INSERT INTO rate_limit_attempt (bucket, key) VALUES ($1, $2)`,
        [bucket, key, String(windowMs)],
      );
    },
    async clear(bucket, key) {
      await pool.query(`DELETE FROM rate_limit_attempt WHERE bucket = $1 AND key = $2`, [bucket, key]);
    },
  };
}

// ── in-process fast-deny (addition, never a replacement) ─────────────────────
/**
 * P8 (A6/G1): wraps the DISTRIBUTED backend with a bounded per-process memo of recent refusals. Once the shared store
 * has said "over the cap, retry in N s" for (bucket, key), this process answers the same refusal without a database
 * round trip for min(N, maxDenyMs). It can only ever DENY — every allow still comes from the shared backend, so
 * enforcement across API processes is unchanged. clear() drops the local memo; a clear() in ANOTHER process is seen
 * here at most maxDenyMs later (a refused key that another process just cleared — rare, and bounded).
 */
export function createFastDenyRateLimitBackend(inner: RateLimitBackend, opts: { maxEntries?: number; maxDenyMs?: number } = {}): RateLimitBackend {
  const maxEntries = opts.maxEntries ?? 10_000;
  const maxDenyMs = opts.maxDenyMs ?? 10_000;
  const denied = new Map<string, number>(); // key -> deny-until epoch ms
  const k = (bucket: string, key: string) => `${bucket}\u0000${key}`;
  const cached = (mk: string): number => {
    const until = denied.get(mk);
    if (until === undefined) return 0;
    const left = until - Date.now();
    if (left <= 0) { denied.delete(mk); return 0; }
    return Math.max(1, Math.ceil(left / 1000));
  };
  const remember = (mk: string, retrySeconds: number) => {
    if (retrySeconds <= 0) return;
    denied.delete(mk);
    denied.set(mk, Date.now() + Math.min(retrySeconds * 1000, maxDenyMs));
    while (denied.size > maxEntries) {
      const oldest = denied.keys().next().value;
      if (oldest === undefined) break;
      denied.delete(oldest);
    }
  };
  return {
    async check(bucket, key, windowMs, maxAttempts) {
      const mk = k(bucket, key);
      const hit = cached(mk);
      if (hit > 0) return hit;
      const r = await inner.check(bucket, key, windowMs, maxAttempts);
      remember(mk, r);
      return r;
    },
    async consume(bucket, key, windowMs, maxAttempts) {
      const mk = k(bucket, key);
      const hit = cached(mk);
      if (hit > 0) return hit;
      const r = await inner.consume(bucket, key, windowMs, maxAttempts);
      remember(mk, r);
      return r;
    },
    async recordFailure(bucket, key, windowMs) {
      await inner.recordFailure(bucket, key, windowMs);
    },
    async clear(bucket, key) {
      denied.delete(k(bucket, key));
      await inner.clear(bucket, key);
    },
  };
}

let singleton: RateLimitBackend | undefined;

/** Resolve once, cache for the process's lifetime. Tests override via
 *  _setRateLimitBackendForTest instead of env manipulation (env is read
 *  once at process start elsewhere in this codebase's convention). */
export function rateLimitBackend(): RateLimitBackend {
  if (!singleton) {
    // Tests run with no database — default to memory in NODE_ENV=test
    // unless a test explicitly asks for postgres (DB-gated rate-limit
    // suites do exactly that). Production defaults to postgres.
    const mode = env.RATE_LIMIT_BACKEND ?? (env.NODE_ENV === 'test' ? 'memory' : 'postgres');
    singleton = mode === 'memory' ? createMemoryRateLimitBackend() : createFastDenyRateLimitBackend(createPostgresRateLimitBackend());
  }
  return singleton;
}

/** Test-only: force a specific backend (or clear the override to re-resolve
 *  from env next call). */
export function _setRateLimitBackendForTest(b: RateLimitBackend | undefined): void {
  singleton = b;
}

/** Buckets whose rows must outlive the generic 24 h retention (their window is longer). Keyed by bucket name; value in hours. */
export const LONG_RETENTION_BUCKETS: Readonly<Record<string, number>> = { 'admin-auth-known': 30 * 24 };

/**
 * Housekeeping for the Postgres backend: every consume()/recordFailure() call
 * already prunes ITS OWN (bucket, key) pair opportunistically, but a
 * (bucket, key) that is never queried again (a one-off IP, a bucket for a
 * feature nobody hits twice) leaves its rows behind forever otherwise. This
 * is pure retention cleanup — a rate_limit_attempt row has ZERO business
 * meaning once it falls out of every plausible window. Wired into
 * jobs/scheduler.ts. No-op (and safe to call) under the memory backend.
 *
 * P8 (D4): bounded. Each pass deletes at most `batchSize` rows per statement and at most `maxBatches` statements, so a
 * backlog (after an outage or a spray) is drained over several scheduler ticks instead of one long table-wide DELETE.
 * Efficient with the attempted_at index (migration in the P8 report); correct without it.
 */
export async function reapRateLimitAttempts(
  retentionHours = 24,
  opts: { batchSize?: number; maxBatches?: number; mode?: 'postgres' | 'memory' } = {},
): Promise<{ deleted: number; complete: boolean }> {
  const mode = opts.mode ?? env.RATE_LIMIT_BACKEND ?? (env.NODE_ENV === 'test' ? 'memory' : 'postgres');
  if (mode === 'memory') return { deleted: 0, complete: true };
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 5000, 50_000));
  const maxBatches = Math.max(1, opts.maxBatches ?? 20);
  const longBuckets = Object.keys(LONG_RETENTION_BUCKETS);
  const passes: Array<{ where: string; params: unknown[] }> = [
    { where: `attempted_at < now() - ($1 || ' hours')::interval AND NOT (bucket = ANY($2::text[]))`, params: [String(retentionHours), longBuckets] },
    ...longBuckets.map((b) => ({
      where: `attempted_at < now() - ($1 || ' hours')::interval AND bucket = $2`,
      params: [String(Math.max(retentionHours, LONG_RETENTION_BUCKETS[b]!)), b] as unknown[],
    })),
  ];
  let deleted = 0;
  let batches = 0;
  let complete = true;
  for (const pass of passes) {
    for (;;) {
      if (batches >= maxBatches) { complete = false; break; }
      const res = await pool.query(
        `DELETE FROM rate_limit_attempt WHERE id IN (
           SELECT id FROM rate_limit_attempt WHERE ${pass.where} LIMIT ${batchSize}
         )`,
        pass.params,
      );
      batches++;
      const n = res.rowCount ?? 0;
      deleted += n;
      if (n < batchSize) break;
    }
    if (!complete) break;
  }
  return { deleted, complete };
}
