import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema.js';
import { getEnv, type Env } from '../env.js';
import { beginAfterCommit, discardAfterCommit, flushAfterCommit } from './after-commit.js';

// ---------------------------------------------------------------------------
// Pools are created by `initPools(env)` (createApp, plugin 2.1) — importing this
// module opens no connection. Code paths that never go through createApp
// (operator scripts, the test runner) get an implicit init from the env
// singleton on first use, exactly as before.
//
// Session-level advisory locks intentionally live on a separate, very small
// pool. Payment/refund workflows hold these locks across external gateway I/O;
// if they borrowed from the main transaction pool, enough concurrent gateway
// calls could occupy every connection and starve the nested withStore() work.
// Keeping lock waiters isolated preserves transaction capacity while retaining
// the existing cross-process serialization semantics.
// ---------------------------------------------------------------------------
interface Pools { pool: Pool; advisoryLockPool: Pool; db: Db }
let pools: Pools | undefined;
let poolsClosed = false;

export function initPools(e: Env = getEnv()): Pool {
  if (pools) throw new Error('database pools are already initialised in this process (one createApp per process)');
  const pool = new Pool({
    connectionString: e.DATABASE_URL,
    application_name: e.PGAPPNAME,
    max: e.PGPOOL_MAX,
    idleTimeoutMillis: e.PGPOOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: e.PGPOOL_CONNECTION_TIMEOUT_MS,
  });
  const advisoryLockPool = new Pool({
    connectionString: e.DATABASE_URL,
    application_name: `${e.PGAPPNAME}-locks`,
    max: Math.max(1, Math.min(4, Math.ceil(e.PGPOOL_MAX / 4))),
    idleTimeoutMillis: e.PGPOOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: e.PGPOOL_CONNECTION_TIMEOUT_MS,
    allowExitOnIdle: true,
  });
  // 'error' fires on IDLE pooled clients (network blip, server kill, idle timeout)
  // — NOT on in-flight queries. Without this handler Node throws an EventEmitter
  // "unhandled error" and exits; in-flight queries keep returning whatever they
  // were doing, masking the silent-failure footgun. See DISPATCH.md §3a REL-5.
  pool.on('error', (err) => {
    console.error('[pg pool error]', err);
  });
  advisoryLockPool.on('error', (err) => {
    console.error('[pg advisory-lock pool error]', err);
  });
  pools = { pool, advisoryLockPool, db: drizzle(pool, drizzleOpts) };
  poolsClosed = false;
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

/** Close both pools (createApp shutdown, last step). Idempotent. */
export async function closePools(): Promise<void> {
  const p = pools;
  pools = undefined;
  poolsClosed = true;
  if (!p) return;
  await Promise.allSettled([p.pool.end(), p.advisoryLockPool.end()]);
}

/** Test-only: forget the pools WITHOUT closing them (the test owns teardown). */
export function _resetPoolsForTest(): void {
  pools = undefined;
  poolsClosed = false;
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
export const pool: Pool = lazyProxy(() => getPools().pool, true);
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
export const unsafeUnscopedDb: Db = lazyProxy(() => getPools().db, false);

// NOTE: the previous `export const db = ...` name has been removed. Any
// remaining callers (migrations/jobs) were updated as part of WP1.3 to import
// `unsafeUnscopedDb` directly. An ESLint `no-restricted-imports` rule on
// `src/routes/**` blocks accidental use there — see eslint.config.js.

export type Tx = NodePgDatabase<typeof schema> & { $client: Pool | PoolClient };

type TxFactory = (client: PoolClient) => Tx;

/** Transaction core extracted so rollback-failure behavior is unit-testable. */
export async function runStoreTransaction<T>(
  client: PoolClient,
  storeId: string,
  fn: (tx: Tx) => Promise<T>,
  makeTx: TxFactory = (c) => drizzle(c, drizzleOpts),
): Promise<T> {
  let broken = false;
  try {
    await client.query('BEGIN');
    beginAfterCommit(client);
    await client.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
    const result = await fn(makeTx(client));
    await client.query('COMMIT');
    flushAfterCommit(client);
    return result;
  } catch (err) {
    discardAfterCommit(client);
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw err;
  } finally {
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
export async function withAdvisoryLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const client = await advisoryLockPool.connect();
  let locked = false;
  let broken = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    locked = true;
    return await fn();
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
      } catch {
        broken = true;
      }
    }
    client.release(broken);
  }
}
