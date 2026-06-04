import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema.js';
import { env } from '../env.js';

export const pool = new Pool({ connectionString: env.DATABASE_URL });

/** Unscoped client — only for migrations, jobs that set their own store context, or admin-cross-store reads. */
export const db = drizzle(pool, { schema });

export type Tx = ReturnType<typeof drizzle>;

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
    const tx = drizzle(client, { schema });
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
