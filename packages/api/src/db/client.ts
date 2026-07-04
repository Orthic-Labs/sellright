import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema.js';
import { env } from '../env.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PGPOOL_MAX,
  idleTimeoutMillis: env.PGPOOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PGPOOL_CONNECTION_TIMEOUT_MS,
});

// 'error' fires on IDLE pooled clients (network blip, server kill, idle timeout)
// — NOT on in-flight queries. Without this handler Node throws an EventEmitter
// "unhandled error" and exits; in-flight queries keep returning whatever they
// were doing, masking the silent-failure footgun. See DISPATCH.md §3a REL-5.
pool.on('error', (err) => {
  console.error('[pg pool error]', err);
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

/**
 * Run `fn` inside a transaction scoped to one store. Sets `app.current_store`
 * transaction-locally so Postgres RLS (see drizzle/0001+0002) confines every
 * query to that store. This is THE entry point for all store-scoped work —
 * the request layer resolves the store, then wraps handlers in withStore.
 */
export async function withStore<T>(storeId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config(..., is_local=true) === SET LOCAL — scoped to this transaction only.
    await client.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
    const tx = drizzle(client, drizzleOpts);
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
