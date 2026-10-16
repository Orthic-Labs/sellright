import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { pool } from './client.js';
import { env } from '../env.js';
import { assertTestDatabase } from './rls-test-utils.js';

/**
 * Empty-string GUC contract. set_config(..., true) is transaction-local, but a
 * pooled connection that ever ran withStore() keeps app.current_store = ''
 * (NOT NULL) afterwards. Every tenant policy must therefore wrap the setting
 * in nullif(..., '') and fail CLOSED (zero rows), never raise 22P02. The
 * fail-closed loop in rls-tables.test.ts uses fresh connections (setting is
 * NULL) and cannot see this.
 */
const DB = process.env.DATABASE_URL ?? '';
assertTestDatabase(DB, 'rls-empty-setting test');
const appPool = new Pool({ connectionString: env.DATABASE_URL_NONOWNER ?? env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
  await appPool.end();
});

describe('RLS with app.current_store = empty string', () => {
  it('no policy casts current_setting() to uuid without nullif', async () => {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_policies WHERE schemaname='public'
         AND (coalesce(qual,'') || coalesce(with_check,'')) ~* 'current_setting'
         AND (coalesce(qual,'') || coalesce(with_check,'')) !~* 'nullif'
       ORDER BY tablename`);
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });

  it('every store-scoped table returns zero rows (no error) when the setting is empty', async () => {
    const { rows } = await pool.query<{ t: string }>(
      `SELECT DISTINCT tablename AS t FROM pg_policies WHERE schemaname='public'
         AND (coalesce(qual,'') || coalesce(with_check,'')) ~* 'current_setting' ORDER BY 1`);
    const tables = rows.map((r) => r.t);
    expect(tables).toEqual(expect.arrayContaining(['email_outbox', 'push_outbox']));
    const client = await appPool.connect();
    try {
      for (const t of tables) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_store', '', true)");
        const res = await client.query(`SELECT count(*)::int AS n FROM "${t}"`);
        await client.query('COMMIT');
        expect(res.rows[0].n, `table ${t}`).toBe(0);
      }
      // Real-world path: GUC left as '' after a committed scoped transaction.
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_store', '11111111-1111-1111-1111-111111111111', true)");
      await client.query('COMMIT');
      for (const t of ['email_outbox', 'push_outbox']) {
        const res = await client.query(`SELECT count(*)::int AS n FROM "${t}"`);
        expect(res.rows[0].n, `table ${t} after committed scoped tx`).toBe(0);
      }
    } finally {
      client.release();
    }
  });
});
