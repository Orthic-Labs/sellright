/** Customer credential changes must serialize with password login. *_test DB only. */
import { createHash } from 'node:crypto';
import { hash as hashBcrypt } from 'bcryptjs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import { env } from '../env.js';
import { createSession } from '../auth/session.js';
import { hashPassword, passwordNeedsRehash, verifyPassword } from '../auth/password.js';
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from '../auth/rate-limit-backend.js';
import { invalidateStoreCache } from '../store-context.js';
import { auth } from './auth.js';
import { customerTokens } from './customer-tokens.js';

requireDisposablePostgresUrl(process.env.DATABASE_URL ?? env.DATABASE_URL, 'customer-auth-race.db.test.ts');

const STORE = 'ca750000-0000-4000-8000-000000000001';
const CUSTOMER = 'ca750000-0000-4000-8000-000000000002';
const SLUG = 'customer-auth-race';
const EMAIL = 'customer@auth-race.test';
const OLD_PASSWORD = 'old-password-auth-race';
const NEW_PASSWORD = 'new-password-auth-race';
const RESET_TOKEN = 'customer-auth-race-reset-token';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

const app = new OpenAPIHono();
app.route('/', auth);
app.route('/', customerTokens);

const post = async (path: string, body: unknown) => app.request(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, 'x-real-ip': '198.51.100.73' },
  body: JSON.stringify(body),
});
const login = (password: string) => post('/v1/shop/auth/login', { email: EMAIL, password });

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  invalidateStoreCache(SLUG);
}

async function seed(passwordHash: string) {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb)`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified, password_hash)
      VALUES (${CUSTOMER}, ${STORE}, ${EMAIL}, true, ${passwordHash})`);
    await tx.execute(sql`INSERT INTO customer_token (store_id, customer_id, kind, token_hash, expires_at)
      VALUES (${STORE}, ${CUSTOMER}, 'password_reset', ${digest(RESET_TOKEN)}, now() + interval '1 hour')`);
    await createSession(tx, STORE, CUSTOMER);
  });
}

async function customerLock(client: PoolClient): Promise<number> {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.current_store', $1, true)`, [STORE]);
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  await client.query('SELECT id FROM customer WHERE id = $1 FOR UPDATE', [CUSTOMER]);
  return rows[0]!.pid;
}

/** Include indirect waiters: login can queue behind reset, which queues behind our lock. */
async function waitForBlockedRequests(blockerPid: number, count: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await pool.query<{ n: number }>(`
      WITH RECURSIVE waiters AS (
        SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
        UNION
        SELECT activity.pid FROM pg_stat_activity activity JOIN waiters ON waiters.pid = ANY(pg_blocking_pids(activity.pid))
        WHERE activity.datname = current_database()
      ) SELECT count(DISTINCT pid)::int AS n FROM waiters`, [blockerPid]);
    if (rows[0]!.n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${count} requests waiting on fixture customer lock`);
}

async function sessionCount() {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM "session" WHERE store_id = $1 AND customer_id = $2', [STORE, CUSTOMER]);
  return rows[0]!.n;
}

beforeEach(async () => {
  _setRateLimitBackendForTest(createMemoryRateLimitBackend());
  await wipe();
});
afterAll(async () => {
  await wipe();
  _setRateLimitBackendForTest(undefined);
  await pool.end();
});

describe('customer login credential races', () => {
  for (const format of ['current Argon2id', 'legacy bcrypt'] as const) {
    it(`reset queued before ${format} login keeps new password & revokes every stale session`, async () => {
      const oldHash = format === 'legacy bcrypt' ? await hashBcrypt(OLD_PASSWORD, 4) : await hashPassword(OLD_PASSWORD);
      expect(passwordNeedsRehash(oldHash)).toBe(format === 'legacy bcrypt');
      await seed(oldHash);
      const blocker = await pool.connect();
      let resetRequest: Promise<Response> | undefined;
      let loginRequest: Promise<Response> | undefined;
      try {
        const blockerPid = await customerLock(blocker);
        // Queue the REAL reset handler first. Both it & login must wait on this
        // fixture row, making reset's credential replacement win deterministically.
        resetRequest = post('/v1/shop/auth/reset-password', { token: RESET_TOKEN, password: NEW_PASSWORD });
        await waitForBlockedRequests(blockerPid, 1);
        loginRequest = login(OLD_PASSWORD);
        await waitForBlockedRequests(blockerPid, 2);
        await blocker.query('COMMIT');
        expect((await resetRequest).status).toBe(200);
        const rejected = await loginRequest;
        expect(rejected.status).toBe(401);
        expect(rejected.headers.get('set-cookie')).toBeNull();
        expect(await sessionCount()).toBe(0);

        const [row] = await withStore(STORE, async (tx) =>
          (await tx.execute(sql`SELECT password_hash FROM customer WHERE id = ${CUSTOMER}`)).rows as Array<{ password_hash: string }>);
        expect(await verifyPassword(OLD_PASSWORD, row!.password_hash)).toBe(false);
        expect(await verifyPassword(NEW_PASSWORD, row!.password_hash)).toBe(true);
        expect((await login(OLD_PASSWORD)).status).toBe(401);
        const accepted = await login(NEW_PASSWORD);
        expect(accepted.status).toBe(200);
        expect(accepted.headers.get('set-cookie')).toContain('sr_cust=');
        expect(await sessionCount()).toBe(1);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
        await Promise.allSettled([resetRequest, loginRequest]);
      }
    }, 30_000);
  }

  for (const change of ['email change', 'erasure'] as const) {
    it(`login cannot create a session after concurrent ${change}`, async () => {
      await seed(await hashPassword(OLD_PASSWORD));
      const blocker = await pool.connect();
      let loginRequest: Promise<Response> | undefined;
      try {
        const blockerPid = await customerLock(blocker);
        if (change === 'email change') {
          await blocker.query('UPDATE customer SET email = $1 WHERE id = $2', ['moved@auth-race.test', CUSTOMER]);
          await blocker.query('DELETE FROM "session" WHERE store_id = $1 AND customer_id = $2', [STORE, CUSTOMER]);
        } else {
          await blocker.query('DELETE FROM customer_token WHERE customer_id = $1', [CUSTOMER]);
          await blocker.query('DELETE FROM "session" WHERE store_id = $1 AND customer_id = $2', [STORE, CUSTOMER]);
          await blocker.query('DELETE FROM customer WHERE id = $1', [CUSTOMER]);
        }
        loginRequest = login(OLD_PASSWORD);
        await waitForBlockedRequests(blockerPid, 1);
        await blocker.query('COMMIT');
        const rejected = await loginRequest;
        expect(rejected.status).toBe(401);
        expect(rejected.headers.get('set-cookie')).toBeNull();
        expect(await sessionCount()).toBe(0);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
        await Promise.allSettled([loginRequest]);
      }
    }, 30_000);
  }
});
