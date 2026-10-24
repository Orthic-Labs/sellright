import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema.js';
import { getEnv, type Env } from '../env.js';
import { beginAfterCommit, discardAfterCommit, flushAfterCommit } from './after-commit.js';
import { log, err as logErr } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Pools are created by `initPools(env)` (createApp, plugin 2.1) — importing this
// module opens no connection. Code paths that never go through createApp
// (operator scripts, the test runner) get an implicit init from the env
// singleton on first use, exactly as before.
//
// Four pools, each with a fixed budget, so no workload can take a connection
// another one needs (#358 / #360):
//   requests  PGPOOL_MAX        HTTP handlers (withStore, pool, unsafeUnscopedDb).
//   jobs      PGJOBS_POOL_MAX   the same three names, resolved here while code
//                               runs inside runInJobScope() (the scheduler wraps
//                               every pass), so a background job can never queue
//                               ahead of a shopper on the request pool.
//   locks     PGLOCKS_POOL_MAX  short single statements only: scheduler_lease
//                               claims/renewals (jobs/leader-lock.ts) and the
//                               readiness probe. Nothing holds one while working.
//   advisory  ceil(PGPOOL_MAX/4) session-level advisory locks. Payment/refund
//                               workflows hold these across external gateway I/O;
//                               keeping them apart preserves transaction capacity
//                               and the cross-process serialization semantics.
// The store-cache LISTEN session is a dedicated pg.Client (store-context.ts),
// outside every pool.
// ---------------------------------------------------------------------------
interface Pools { pool: Pool; jobsPool: Pool; locksPool: Pool; advisoryLockPool: Pool; db: Db; jobsDb: Db; gauge?: NodeJS.Timeout }
let pools: Pools | undefined;
let poolsClosed = false;

const jobScope = new AsyncLocalStorage<true>();

/** Run `fn` with `pool` / `withStore` / `unsafeUnscopedDb` resolving to the jobs pool (the scheduler wraps every pass). */
export function runInJobScope<T>(fn: () => Promise<T>): Promise<T> {
  return jobScope.run(true, fn);
}

/** True inside runInJobScope(). */
export function inJobScope(): boolean {
  return jobScope.getStore() === true;
}

/** Server-side session limits sent as startup options, so they hold whatever the role defaults are. Jobs may scan a
 *  whole store (120 s statements). Advisory sessions only run lock/unlock statements: a lock wait is bounded by
 *  PGADVISORY_LOCK_WAIT_MS (#360 N1 — never unbounded, matching the production roles' lock_timeout) and each
 *  statement by 30 s. */
const JOBS_SESSION = '-c statement_timeout=120000';
const JOBS_QUERY_TIMEOUT_MS = 125_000;
/** Lease claims/renewals and the readiness probe are single trivial statements. */
export const LOCKS_QUERY_TIMEOUT_MS = 3_000;
const advisorySession = (e: Env) => `-c statement_timeout=30000 -c lock_timeout=${e.PGADVISORY_LOCK_WAIT_MS}`;

export function initPools(e: Env = getEnv()): Pool {
  if (pools) throw new Error('database pools are already initialised in this process (one createApp per process)');
  const make = (name: string, max: number, extra: Record<string, unknown> = {}) => {
    const p = new Pool({
      connectionString: e.DATABASE_URL,
      application_name: name,
      max,
      idleTimeoutMillis: e.PGPOOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: e.PGPOOL_CONNECTION_TIMEOUT_MS,
      // TCP keepalive (#360 M1): a half-open socket (peer gone without FIN) is detected by the kernel instead of
      // pinning a pooled connection until the OS gives up minutes later.
      keepAlive: true,
      ...extra,
    });
    // 'error' fires on IDLE pooled clients (network blip, server kill, idle timeout)
    // — NOT on in-flight queries. Without this handler Node throws an EventEmitter
    // "unhandled error" and exits; in-flight queries keep returning whatever they
    // were doing, masking the silent-failure footgun. See DISPATCH.md §3a REL-5.
    p.on('error', (err) => { console.error(`[pg pool error] ${name}`, err); });
    return p;
  };
  const pool = make(e.PGAPPNAME, e.PGPOOL_MAX);
  // Client-side ceilings (#360 H2/M1) on top of the server's statement_timeout: a query on a hung connection is
  // abandoned (and its client discarded) even when the server never answers.
  const jobsPool = make(`${e.PGAPPNAME}-jobs`, e.PGJOBS_POOL_MAX, { allowExitOnIdle: true, options: JOBS_SESSION, query_timeout: JOBS_QUERY_TIMEOUT_MS });
  const locksPool = make(`${e.PGAPPNAME}-lease`, e.PGLOCKS_POOL_MAX, { allowExitOnIdle: true, query_timeout: LOCKS_QUERY_TIMEOUT_MS });
  const advisoryLockPool = make(`${e.PGAPPNAME}-locks`, advisoryPoolMax(e), { allowExitOnIdle: true, options: advisorySession(e) });
  pools = { pool, jobsPool, locksPool, advisoryLockPool, db: drizzle(pool, drizzleOpts), jobsDb: drizzle(jobsPool, drizzleOpts) };
  poolsClosed = false;
  if (e.NODE_ENV !== 'test') {
    // Saturation is logged before it turns into connect timeouts: a line every 30 s while any pool has waiters or
    // is at 80 % of its budget, silent otherwise. Live numbers are on /v1/readyz.
    const gauge = setInterval(() => {
      const g = poolGauges();
      const pressured = Object.values(g).some((p) => p.waiting > 0 || p.total - p.idle >= Math.ceil(p.max * 0.8));
      if (pressured) log.warn('db pool pressure', { pools: g });
    }, 30_000);
    gauge.unref();
    pools.gauge = gauge;
  }
  return pool;
}

function getPools(): Pools {
  if (pools) return pools;
  if (poolsClosed) throw new Error('database pool used after engine shutdown');
  initPools();
  return pools!;
}

/** True once a pool exists (explicitly or implicitly). Never creates one. */
export function poolsInitialised(): boolean {
  return pools !== undefined;
}

export interface PoolGauge { max: number; total: number; idle: number; waiting: number }

/** Per-pool connection counts (readiness probe, pressure log). Empty before the pools exist; never creates them. */
export function poolGauges(): Record<string, PoolGauge> {
  if (!pools) return {};
  const g = (p: Pool): PoolGauge => ({ max: p.options.max ?? 0, total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount });
  return { requests: g(pools.pool), jobs: g(pools.jobsPool), locks: g(pools.locksPool), advisory: g(pools.advisoryLockPool) };
}

/** Close every pool (createApp shutdown, last step). Idempotent. */
export async function closePools(): Promise<void> {
  const p = pools;
  pools = undefined;
  poolsClosed = true;
  if (!p) return;
  clearInterval(p.gauge);
  await Promise.allSettled([p.pool.end(), p.jobsPool.end(), p.locksPool.end(), p.advisoryLockPool.end()]);
}

/** Test-only: forget the pools WITHOUT closing them (the test owns teardown). */
export function _resetPoolsForTest(): void {
  if (pools) clearInterval(pools.gauge);
  pools = undefined;
  poolsClosed = false;
}

const advisoryPoolMax = (e: Env) => Math.max(1, Math.min(4, Math.ceil(e.PGPOOL_MAX / 4)));

/** #360 N7: the most connections one API process can open, by consumer. The tenant resolver
 *  (payments/tenant-resolution.ts) and the per-pass webhook pool (webhooks/emit.ts) are fixed at 2 each. */
export function connectionBudget(e: Env = getEnv()): { total: number; parts: Record<string, number> } {
  const parts = {
    requests: e.PGPOOL_MAX, jobs: e.PGJOBS_POOL_MAX, locks: e.PGLOCKS_POOL_MAX, advisory: advisoryPoolMax(e),
    tenantResolution: 2, webhookPass: 2, listener: 1,
  };
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}

/** Boot check (createApp, best-effort): log this process's connection maximum and warn when it exceeds
 *  PG_CONNECTION_BUDGET, the runtime role's connection limit, or max_connections minus the superuser reserve. */
export async function checkConnectionBudget(e: Env = getEnv()): Promise<void> {
  const { total, parts } = connectionBudget(e);
  const { rows } = await locksPool.query<{ max: number; reserved: number; connlimit: number }>(
    `SELECT current_setting('max_connections')::int AS max,
            current_setting('superuser_reserved_connections')::int AS reserved,
            (SELECT rolconnlimit FROM pg_roles WHERE rolname = current_user) AS connlimit`,
  );
  const r = rows[0]!;
  const limits: Array<[string, number]> = [['max_connections minus reserve', r.max - r.reserved]];
  if (r.connlimit >= 0) limits.push(['role connection limit', r.connlimit]);
  if (e.PG_CONNECTION_BUDGET) limits.push(['PG_CONNECTION_BUDGET', e.PG_CONNECTION_BUDGET]);
  const over = limits.filter(([, limit]) => total > limit);
  const fields = { maxConnections: total, parts, limits: Object.fromEntries(limits) };
  if (over.length) log.warn('db connection budget exceeded: this process alone can open more connections than allowed', { ...fields, exceeded: over.map(([name]) => name) });
  else log.info('db connection budget', fields);
}

/** Boot check (createApp, best-effort; #360 L5): job leadership needs the runtime role to read and write
 *  scheduler_lease. A missing grant (a migration run as a role whose default privileges don't cover the app role)
 *  would make every scheduled pass fail; say so once, loudly, at boot. */
export async function checkSchedulerLeaseAccess(): Promise<void> {
  const { rows } = await locksPool.query<{ ok: boolean | null }>(
    "SELECT CASE WHEN to_regclass('public.scheduler_lease') IS NULL THEN NULL ELSE has_table_privilege(current_user, 'public.scheduler_lease', 'SELECT,INSERT,UPDATE,DELETE') END AS ok",
  );
  const ok = rows[0]?.ok;
  if (ok === null) logErr.error('scheduler_lease is missing (migration 0112 not applied): every leader-locked job will fail');
  else if (!ok) logErr.error('the runtime role lacks SELECT/INSERT/UPDATE/DELETE on scheduler_lease: every leader-locked job will fail; grant it as the owner');
}

/** #360 N2: a scheduler lease the current job pass holds (jobs/leader-lock.ts). While one is in scope, every store
 *  transaction re-checks it, row-locked, right before COMMIT, so a worker whose lease expired or was taken over can
 *  never commit; `signal` aborts when renewal finds the lease gone. */
export interface LeaseFence { name: string; token: string; lost: boolean; released: boolean; readonly signal: AbortSignal }
const leaseScope = new AsyncLocalStorage<readonly LeaseFence[]>();

/** Run `fn` with `fence` added to the leases every store transaction it starts must still hold at COMMIT. */
export function runWithLeaseFence<T>(fence: LeaseFence, fn: () => Promise<T>): Promise<T> {
  return leaseScope.run([...(leaseScope.getStore() ?? []), fence], fn);
}

/** Run `fn` outside any job pass: no job scope (its SQL uses the request pool) and no lease fence. Every point where
 *  a pass starts work it does not await (after-commit callbacks, stock-change hooks, the email waker) goes through
 *  this, so the detached work neither borrows the pass's pool nor dies with its lease (#360 H1). */
export function detachFromPass<T>(fn: () => T): T {
  return jobScope.exit(() => leaseScope.exit(fn));
}

/** The abort signal of the innermost lease in scope (undefined outside a leader-locked pass). */
export function currentLeaseSignal(): AbortSignal | undefined {
  return leaseScope.getStore()?.at(-1)?.signal;
}

export class LeaseLostError extends Error {
  constructor(name: string) { super(`scheduler lease "${name}" is no longer held; the transaction was rolled back`); }
}

async function assertLeasesHeld(client: PoolClient, fences: readonly LeaseFence[]): Promise<void> {
  for (const f of fences) {
    if (f.lost) throw new LeaseLostError(f.name);
    // A fence still in scope after its pass ended belongs to detached work that escaped detachFromPass(); the pass
    // gave the lease back on purpose, so that work is not refused (#360 H1). Only a LOST lease refuses commits.
    if (f.released) continue;
    // FOR SHARE: a competing claim (INSERT … ON CONFLICT DO UPDATE) waits for this COMMIT, so the lease cannot change
    // hands between this check and the commit. clock_timestamp(), not now(): the transaction may be old.
    const r = await client.query(
      'SELECT 1 FROM scheduler_lease WHERE name = $1 AND token = $2 AND expires_at > clock_timestamp() FOR SHARE',
      [f.name, f.token],
    );
    if (!r.rowCount) { f.lost = true; throw new LeaseLostError(f.name); }
  }
}

/** No connection in time: pg-pool's acquire timeout (no client freed up within PGPOOL_CONNECTION_TIMEOUT_MS), a
 *  connect that timed out, or the server refusing with too_many_connections (53300). Maps to 503 (app.ts) and to
 *  "skipped: pool busy" in the scheduler. */
export function isPoolTimeout(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof Error && (e.message.includes('timeout exceeded when trying to connect')
      || e.message.includes('Connection terminated due to connection timeout'))) return true;
    if ((e as { code?: unknown }).code === '53300') return true; // too_many_connections: the server's own limit
  }
  return false;
}

/** Forward every operation to a lazily-resolved target (see `pool` / `unsafeUnscopedDb`). */
function lazyProxy<T extends object>(resolve: () => T, bindMethods: boolean): T {
  return new Proxy({} as T, {
    get: (_t, key) => {
      const target = resolve();
      const value = Reflect.get(target, key);
      return bindMethods && typeof value === 'function' && key !== 'constructor' ? value.bind(target) : value;
    },
    set: (_t, key, value) => Reflect.set(resolve(), key, value),
    has: (_t, key) => Reflect.has(resolve(), key),
    getPrototypeOf: () => Reflect.getPrototypeOf(resolve()),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_t, key) => {
      const d = Reflect.getOwnPropertyDescriptor(resolve(), key);
      if (d) d.configurable = true;
      return d;
    },
  });
}

/** The runtime pool. Lazy view over the pool createApp (or first use) created. */
/** The runtime pool. Lazy view over the pool createApp (or first use) created: the request pool, or the jobs pool
 *  inside runInJobScope(). */
export const pool: Pool = lazyProxy(() => (inJobScope() ? getPools().jobsPool : getPools().pool), true);
/** Short single statements only (lease claims, readiness probe): never hold a client from it across other work. */
export const locksPool: Pool = lazyProxy(() => getPools().locksPool, true);
const advisoryLockPool: Pool = lazyProxy(() => getPools().advisoryLockPool, true);

/**
 * SR-01: the request-serving role must never be a superuser or BYPASSRLS —
 * both bypass even FORCE ROW LEVEL SECURITY and silently void tenant
 * isolation. Migration/bootstrap scripts legitimately connect as the
 * privileged owner role; `DATABASE_URL` in a serving process must point at
 * the dedicated NOSUPERUSER NOBYPASSRLS app role (see
 * docs/runbooks/postgres-app-role.md). The queryable parameter defaults to
 * the runtime pool but is injectable so tests can check either side.
 */
interface RoleAttrs { rolsuper: boolean; rolbypassrls: boolean }
interface RoleQueryable { query(text: string): Promise<{ rows: RoleAttrs[] }> }

export async function assertRuntimeRoleUnprivileged(
  db: RoleQueryable = pool,
): Promise<void> {
  const { rows } = await db.query(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const role = rows[0];
  if (role?.rolsuper || role?.rolbypassrls) {
    throw new Error(
      `Refusing to serve requests as a privileged Postgres role ` +
      `(rolsuper=${role.rolsuper}, rolbypassrls=${role.rolbypassrls}). ` +
      `Point DATABASE_URL at the dedicated NOSUPERUSER NOBYPASSRLS app role; ` +
      `keep the privileged role for migrate/bootstrap only (SR-01).`,
    );
  }
}

// The privilege check runs inside createApp (sdk/create-app.ts, plan 2.6), not at
// import: scripts (dist/scripts/migrate.js, bootstrap.js, seed-admin.js, job
// CLIs) and the test runner connect privileged on purpose and never call it.

// MUST match drizzle.config.ts `casing: 'snake_case'` — otherwise runtime queries
// emit camelCase column names the snake_case DB doesn't have.
const drizzleOpts = { schema, casing: 'snake_case' } as const;

/**
 * Unscoped client — ONLY for migrations, jobs that set their own store context,
 * or admin-cross-store reads. Route handlers MUST use withStore().
 *
 * Named `unsafeUnscopedDb` + JSDoc warning so a lint rule (see eslint.config.js
 * `no-restricted-imports`) can block imports from src/routes/. See
 * docs/ARCHITECTURE.md.
 */
type Db = ReturnType<typeof makeDb>;
function makeDb(p: Pool) { return drizzle(p, drizzleOpts); }
export const unsafeUnscopedDb: Db = lazyProxy(() => (inJobScope() ? getPools().jobsDb : getPools().db), false);

// NOTE: the previous `export const db = ...` name has been removed. Any
// remaining callers (migrations/jobs) were updated as part of WP1.3 to import
// `unsafeUnscopedDb` directly. An ESLint `no-restricted-imports` rule on
// `src/routes/**` blocks accidental use there — see eslint.config.js.

export type Tx = NodePgDatabase<typeof schema> & { $client: Pool | PoolClient };

type TxFactory = (client: PoolClient) => Tx;

/** Transaction core extracted so rollback-failure behavior is unit-testable.
 * Optional deadline closes the actual non-pipelined pg connection: query_timeout
 * alone only abandons its caller while SQL can still be running on the server.
 * This owner alone releases the client, after physical closure on timeout. */
export async function runStoreTransaction<T>(
  client: PoolClient,
  storeId: string,
  fn: (tx: Tx) => Promise<T>,
  makeTx: TxFactory = (c) => drizzle(c, drizzleOpts),
  options: { timeoutMs?: number } = {},
): Promise<T> {
  let broken = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: Error | undefined;
  const fences = leaseScope.getStore();
  let closing: Promise<void> | undefined;
  const deadline = options.timeoutMs === undefined ? undefined : new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timeoutError = new Error(`Store transaction timed out after ${options.timeoutMs}ms`);
      broken = true;
      discardAfterCommit(client);
      // pg's public end() destroys a socket with an active non-pipelined query.
      // Retain its promise: release(true) alone does not wait for socket close.
      try { closing = client.end(); }
      catch (error) { closing = Promise.reject(error); }
      void closing.then(() => reject(timeoutError), () => reject(timeoutError));
    }, options.timeoutMs);
  });
  const bounded = <U>(work: Promise<U>): Promise<U> => deadline ? Promise.race([work, deadline]) : work;
  try {
    return await bounded((async () => {
      await client.query('BEGIN');
      if (timeoutError) throw timeoutError;
      beginAfterCommit(client);
      await client.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
      if (timeoutError) throw timeoutError;
      const result = await fn(makeTx(client));
      if (timeoutError) throw timeoutError;
      if (fences?.length) await assertLeasesHeld(client, fences);
      if (timeoutError) throw timeoutError;
      await client.query('COMMIT');
      if (timeoutError) throw timeoutError;
      detachFromPass(() => flushAfterCommit(client)); // after-commit work is never part of a job pass (#360 H1)
      return result;
    })());
  } catch (err) {
    discardAfterCommit(client);
    if (!timeoutError) {
      try { await bounded(client.query('ROLLBACK')); }
      catch { broken = true; }
    }
    throw timeoutError ?? err;
  } finally {
    clearTimeout(timer);
    // Consume a close failure too, preserving the transaction/timeout error.
    if (closing) await closing.catch(() => { broken = true; });
    client.release(broken);
  }
}

/**
 * Run `fn` inside a transaction scoped to one store. Sets `app.current_store`
 * transaction-locally so Postgres RLS (see drizzle/0001+0002) confines every
 * query to that store. This is THE entry point for all store-scoped work —
 * the request layer resolves the store, then wraps handlers in withStore.
 */
export async function withStore<T>(storeId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  return runStoreTransaction(client, storeId, fn);
}

/**
 * Serialize a short transaction → external I/O → short transaction workflow
 * without holding an open Postgres transaction across the external call.
 *
 * The advisory-lock connection comes from a dedicated pool so gateway latency
 * can never exhaust the application's normal transaction pool. The lock remains
 * session-scoped and therefore works across API processes sharing Postgres.
 */
declare const advisoryBrand: unique symbol;
export type HeldAdvisoryLocks = { readonly [advisoryBrand]: true };
interface AdvisoryWitness { keys: Set<string>; active: boolean; used: boolean; work?: Promise<unknown> }
const advisoryWitnesses = new WeakMap<object, AdvisoryWitness>();

/** Acquire all workflow keys on one connection, in lexical order (pay before refund).
 *  Each explicit token permits one covered operation; duplicate/nested consumers
 *  reject before running. The owner retains locks until accepted work settles,
 *  including work its callback failed to await. No async context inheritance. */
export async function withAdvisoryLocks<T>(
  lockKeys: readonly string[], fn: (held: HeldAdvisoryLocks) => Promise<T>,
): Promise<T> {
  const keys = [...new Set(lockKeys)].sort();
  const client = await advisoryLockPool.connect();
  const locked: string[] = [];
  const held = {} as HeldAdvisoryLocks;
  const witness: AdvisoryWitness = { keys: new Set(keys), active: true, used: false };
  advisoryWitnesses.set(held, witness);
  let broken = false;
  let alarm: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const key of keys) {
      try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
        locked.push(key);
      } catch (error) {
        broken = true; // an interrupted acquire may have succeeded on the backend
        throw error;
      }
    }
    // #360 N1: a workflow still holding its locks after PGADVISORY_WORKFLOW_ALARM_MS is reported, never released:
    // its gateway call may still be in flight, and releasing would let a second workflow write over it.
    alarm = setTimeout(() => logErr.error('advisory-locked workflow is still running past its alarm; locks stay held until it settles', undefined, { keys, alarmMs: getEnv().PGADVISORY_WORKFLOW_ALARM_MS }), getEnv().PGADVISORY_WORKFLOW_ALARM_MS);
    alarm.unref?.();
    return await fn(held);
  } finally {
    clearTimeout(alarm);
    witness.active = false;
    // A callback can return/throw without awaiting its accepted operation. Drain
    // it before releasing locks; awaited failures still reach the callback.
    await witness.work?.catch(() => undefined);
    for (const key of locked.reverse()) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
      } catch {
        broken = true;
      }
    }
    client.release(broken);
  }
}

export async function withAdvisoryLock<T>(
  lockKey: string, fn: () => Promise<T>, held?: HeldAdvisoryLocks,
): Promise<T> {
  if (held !== undefined) {
    const witness = advisoryWitnesses.get(held);
    if (!witness?.active || !witness.keys.has(lockKey)) throw new Error('Advisory lock token does not cover this active workflow');
    if (witness.used) throw new Error('Advisory lock token already used by a covered operation');
    witness.used = true;
    const work = Promise.resolve().then(fn);
    witness.work = work;
    return work;
  }
  return withAdvisoryLocks([lockKey], fn);
}
