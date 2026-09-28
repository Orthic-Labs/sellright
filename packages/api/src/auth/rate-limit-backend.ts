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
 * Concurrency note (Postgres backend): `consume` prunes, counts, and
 * conditionally inserts across two round-trips with no row lock between
 * them — two concurrent requests for the SAME key can both observe
 * "under cap" and both insert, admitting one attempt more than the nominal
 * cap under a genuinely concurrent burst. This is a deliberate, accepted
 * softness for a rate limiter (it bounds abuse, it is not a payment/
 * allocation invariant); the in-memory backend has the same property
 * removed only because Node's single-threaded event loop can't race with
 * itself between two `await`-free lines, which this backend does have
 * (network round-trips to Postgres).
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
interface Entry { attempts: number[]; }

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
  const cleanup = (now: number, windowMs: number) => {
    if (store.size <= 5000) return;
    for (const [kk, e] of store) {
      prune(e, now, windowMs);
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
      const e = store.get(mk) ?? { attempts: [] };
      const now = Date.now();
      prune(e, now, windowMs);
      const retry = retryFor(e, now, windowMs, maxAttempts);
      if (retry > 0) return retry;
      e.attempts.push(now);
      store.set(mk, e);
      cleanup(now, windowMs);
      return 0;
    },
    async recordFailure(bucket, key, windowMs) {
      const mk = k(bucket, key);
      const e = store.get(mk) ?? { attempts: [] };
      const now = Date.now();
      prune(e, now, windowMs);
      e.attempts.push(now);
      store.set(mk, e);
      cleanup(now, windowMs);
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
export function createPostgresRateLimitBackend(): RateLimitBackend {
  async function pruneAndCount(bucket: string, key: string, windowMs: number): Promise<{ n: number; oldest: Date | null }> {
    await pool.query(
      `DELETE FROM rate_limit_attempt WHERE bucket = $1 AND key = $2 AND attempted_at < now() - ($3 || ' milliseconds')::interval`,
      [bucket, key, windowMs],
    );
    const { rows } = await pool.query<{ n: string; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(attempted_at) AS oldest FROM rate_limit_attempt WHERE bucket = $1 AND key = $2`,
      [bucket, key],
    );
    return { n: Number(rows[0]?.n ?? 0), oldest: rows[0]?.oldest ?? null };
  }
  function retryFrom(oldest: Date | null, windowMs: number): number {
    if (!oldest) return 1;
    return Math.max(1, Math.ceil((windowMs - (Date.now() - oldest.getTime())) / 1000));
  }
  return {
    async check(bucket, key, windowMs, maxAttempts) {
      const { n, oldest } = await pruneAndCount(bucket, key, windowMs);
      return n < maxAttempts ? 0 : retryFrom(oldest, windowMs);
    },
    async consume(bucket, key, windowMs, maxAttempts) {
      const { n, oldest } = await pruneAndCount(bucket, key, windowMs);
      if (n >= maxAttempts) return retryFrom(oldest, windowMs);
      await pool.query(`INSERT INTO rate_limit_attempt (bucket, key) VALUES ($1, $2)`, [bucket, key]);
      return 0;
    },
    async recordFailure(bucket, key, windowMs) {
      await pool.query(
        `DELETE FROM rate_limit_attempt WHERE bucket = $1 AND key = $2 AND attempted_at < now() - ($3 || ' milliseconds')::interval`,
        [bucket, key, windowMs],
      );
      await pool.query(`INSERT INTO rate_limit_attempt (bucket, key) VALUES ($1, $2)`, [bucket, key]);
    },
    async clear(bucket, key) {
      await pool.query(`DELETE FROM rate_limit_attempt WHERE bucket = $1 AND key = $2`, [bucket, key]);
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
    singleton = mode === 'memory' ? createMemoryRateLimitBackend() : createPostgresRateLimitBackend();
  }
  return singleton;
}

/** Test-only: force a specific backend (or clear the override to re-resolve
 *  from env next call). */
export function _setRateLimitBackendForTest(b: RateLimitBackend | undefined): void {
  singleton = b;
}

/**
 * Housekeeping for the Postgres backend: every consume()/recordFailure() call
 * already prunes ITS OWN (bucket, key) pair opportunistically, but a
 * (bucket, key) that is never queried again (a one-off IP, a bucket for a
 * feature nobody hits twice) leaves its rows behind forever otherwise. This
 * is pure retention cleanup — a rate_limit_attempt row has ZERO business
 * meaning once it falls out of every plausible window, unlike e.g.
 * processed_event's idempotency concern — so it always applies, no dry-run
 * flag, matching cart-maintenance.ts's own always-apply posture. Wired into
 * jobs/scheduler.ts. No-op (and safe to call) under the memory backend —
 * there is no table to sweep.
 */
export async function reapRateLimitAttempts(retentionHours = 24): Promise<{ deleted: number }> {
  const mode = env.RATE_LIMIT_BACKEND ?? (env.NODE_ENV === 'test' ? 'memory' : 'postgres');
  if (mode === 'memory') return { deleted: 0 };
  const res = await pool.query(
    `DELETE FROM rate_limit_attempt WHERE attempted_at < now() - ($1 || ' hours')::interval`,
    [retentionHours],
  );
  return { deleted: res.rowCount ?? 0 };
}
