import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTestDatabase } from './rls-test-utils.js';

const url = process.env.DATABASE_URL ?? '';
assertTestDatabase(url, 'migration compatibility fixture');
const pool = new Pool({ connectionString: url, max: 1 });
const folder = new URL('../../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', folder), 'utf8')) as {
  entries: { tag: string }[];
};
function migration(suffix: string): string {
  const entry = journal.entries.find(({ tag }) => tag.endsWith(suffix));
  if (!entry) throw new Error(`Missing migration: ${suffix}`);
  return readFileSync(new URL(`${entry.tag}.sql`, folder), 'utf8');
}
afterAll(() => pool.end());

describe('upgrade compatibility', () => {
  it('preserves every existing token through the email-change and passwordless migrations', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        CREATE TEMP TABLE customer_token (
          id integer PRIMARY KEY, kind text NOT NULL, token_hash text NOT NULL,
          CONSTRAINT customer_token_kind_check CHECK (
            kind IN ('password_reset', 'email_verify', 'set_password', 'magic_link')
          )
        ) ON COMMIT DROP;
        CREATE TEMP TABLE email_outbox (store_id uuid) ON COMMIT DROP;
        CREATE TEMP TABLE customer (store_id uuid) ON COMMIT DROP;
        INSERT INTO customer_token VALUES
          (1, 'magic_link', 'synthetic-magic'), (2, 'email_verify', 'synthetic-verify'),
          (3, 'password_reset', 'synthetic-reset'), (4, 'set_password', 'synthetic-set');
      `);
      const before = (await client.query('SELECT * FROM customer_token ORDER BY id')).rows;
      await client.query(migration('_email_change_outbox_dedupe'));
      expect((await client.query('SELECT id, kind, token_hash FROM customer_token ORDER BY id')).rows).toEqual(before);
      await client.query("INSERT INTO customer_token (id, kind, token_hash) VALUES (5, 'email_change', 'synthetic-change')");
      await client.query(migration('_passwordless_signin'));
      expect((await client.query('SELECT id, kind, token_hash FROM customer_token WHERE id < 5 ORDER BY id')).rows).toEqual(before);
      await client.query('SAVEPOINT invalid_kind');
      await expect(client.query("INSERT INTO customer_token (id, kind, token_hash) VALUES (6, 'invalid', 'synthetic')"))
        .rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT invalid_kind');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('repairs the legacy subscription policy without modifying rows', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        CREATE TEMP TABLE subscription (store_id uuid) ON COMMIT DROP;
        INSERT INTO subscription VALUES ('11111111-1111-1111-1111-111111111111');
        ALTER TABLE subscription ENABLE ROW LEVEL SECURITY;
        ALTER TABLE subscription FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON subscription
          USING (store_id = current_setting('app.current_store', true)::uuid)
          WITH CHECK (store_id = current_setting('app.current_store', true)::uuid);
      `);
      await client.query(migration('_subscription_policy_reconcile'));
      await client.query(migration('_subscription_policy_reconcile'));
      const policy = (await client.query(`SELECT pg_get_expr(polqual, polrelid) AS using_expr,
        pg_get_expr(polwithcheck, polrelid) AS check_expr FROM pg_policy
        WHERE polrelid = 'pg_temp.subscription'::regclass`)).rows[0];
      expect(policy.using_expr).toContain('NULLIF');
      expect(policy.check_expr).toContain('NULLIF');
      await client.query("SELECT set_config('app.current_store', '', true)");
      expect((await client.query(`SELECT (${policy.using_expr}) AS allowed FROM subscription`)).rows)
        .toEqual([{ allowed: null }]);
      expect((await client.query('SELECT count(*)::int AS count FROM subscription')).rows[0].count).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
