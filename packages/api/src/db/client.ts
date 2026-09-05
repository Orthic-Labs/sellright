import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema.js';
import { env } from '../env.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  application_name: env.PGAPPNAME,
  max: env.PGPOOL_MAX,
  idleTimeoutMillis: env.PGPOOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PGPOOL_CONNECTION_TIMEOUT_MS,
});

// Session-level advisory locks intentionally live on a separate, very small
// pool. Payment/refund workflows hold these locks across external gateway I/O;
// if they borrowed from the main transaction pool, enough concurrent gateway
// calls could occupy every connection and starve the nested withStore() work.
// Keeping lock waiters isolated preserves transaction capacity while retaining
// the existing cross-process serialization semantics.
const advisoryLockPool = new Pool({
  connectionString: env.DATABASE_URL,
  application_name: `${env.PGAPPNAME}-locks`,
  max: Math.max(1, Math.min(4, Math.ceil(env.PGPOOL_MAX / 4))),
  idleTimeoutMillis: env.PGPOOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PGPOOL_CONNECTION_TIMEOUT_MS,
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
export const unsafeUnscopedDb = drizzle(pool, drizzleOpts);

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
    await client.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
    const result = await fn(makeTx(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
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
