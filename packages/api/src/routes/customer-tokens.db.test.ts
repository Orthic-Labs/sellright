/**
 * DB tests for the customer-token routes (SR-05 branding, SR-12 durable send,
 * PAR-06 Turnstile wiring, emailAddressChangeHandler parity).
 *
 * Covers:
 *   1. forgot-password enqueues a password_reset outbox row whose sender +
 *      link come from the RESOLVED store's config — never the env globals of
 *      another tenant (SR-05 regression guard; env points at brand A).
 *   2. Turnstile enforced when the store config carries a secret
 *      (register/login/forgot-password fail closed on verification failure).
 *   3. request-email-change → verification mail to the NEW address →
 *      verify-email-change flips customer.email, marks the token used
 *      (single-use), expires, supersedes older links, kills sessions.
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { invalidateStoreCache } from '../store-context.js';

// PAR-06 seam: the turnstile helper lives in the par-customer lane — mock it so
// these tests exercise OUR wiring (secret resolution + fail-closed), not theirs.
vi.mock('../security/turnstile.js', () => ({
  verifyTurnstileToken: vi.fn(async () => true),
}));

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'customer-tokens.db.test.ts');

import { verifyTurnstileToken } from '../security/turnstile.js';
import { customerTokens } from './customer-tokens.js';
import { auth } from './auth.js';
import { hashPassword } from '../auth/password.js';
import * as passwordAuth from '../auth/password.js';
import { createSession } from '../auth/session.js';
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from '../auth/rate-limit-backend.js';

const STORE_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const STORE_B = 'bbbbbbbb-2222-2222-2222-222222222222';
const STORE_T = 'cccccccc-3333-3333-3333-333333333333';
const SLUG_A = 'ct-brand-a';
const SLUG_B = 'ct-brand-b';
const SLUG_T = 'ct-brand-t';

const app = new OpenAPIHono();
app.route('/', customerTokens);
app.route('/', auth);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seedStores(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES
       ($1, $4, 'Brand A', 'USD', $7::jsonb),
       ($2, $5, 'Brand B', 'EUR', $8::jsonb),
       ($3, $6, 'Turnstile Store', 'USD', $9::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      STORE_A, STORE_B, STORE_T, SLUG_A, SLUG_B, SLUG_T,
      JSON.stringify({ storefrontUrl: 'https://a-brand.example', emailFrom: 'orders@a-brand.example' }),
      JSON.stringify({ storefrontUrl: 'https://b-brand.example', emailFrom: 'orders@b-brand.example' }),
      JSON.stringify({ storefrontUrl: 'https://t-brand.example', emailFrom: 'orders@t-brand.example', turnstileSecretKey: 'cf-secret-1' }),
    ],
  );
}

beforeEach(async () => {
  _setRateLimitBackendForTest(createMemoryRateLimitBackend());
  vi.mocked(verifyTurnstileToken).mockResolvedValue(true);
  await wipe();
  await seedStores();
  invalidateStoreCache();
});
afterAll(async () => { await wipe(); _setRateLimitBackendForTest(undefined); await pool.end(); });

const hdr = (slug: string, extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': slug, ...extra });

async function seedCustomer(storeId: string, email: string, password = 'correcthorsebattery'): Promise<{ id: string }> {
  return withStore(storeId, async (tx) => {
    const [c] = await tx.insert(s.customer).values({ storeId, email, passwordHash: await hashPassword(password), emailVerified: true }).returning({ id: s.customer.id });
    return { id: c!.id };
  });
}

// `type` so it stays `as`-castable from tx.execute's Record<string, unknown>[].
type OutboxRow = { id: string; kind: string; recipient: string; payload: { to?: string; from?: string; subject?: string; html?: string; text?: string }; status: string };

// Explicit store_id filter — the test pool's superuser bypasses RLS, so
// withStore alone would return every tenant's rows.
async function outbox(storeId: string): Promise<OutboxRow[]> {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`SELECT id, kind, recipient, payload, status FROM email_outbox WHERE store_id = ${storeId} ORDER BY created_at`);
    return r.rows as OutboxRow[];
  });
}

describe('POST /v1/shop/auth/forgot-password (SR-05 + SR-12)', () => {
  it('enqueues a durable password_reset branded for the resolved store', async () => {
    await seedCustomer(STORE_B, 'reset-me@b.test');
    const res = await app.request('/v1/shop/auth/forgot-password', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ email: 'reset-me@b.test' }),
    });
    expect(res.status).toBe(200);
    const rows = await outbox(STORE_B);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('password_reset');
    expect(row.status).toBe('pending'); // durable — retries via deliverEmails, not inline
    expect(row.recipient).toBe('reset-me@b.test');
    expect(row.payload.from).toBe('orders@b-brand.example');
    expect(row.payload.html).toContain('https://b-brand.example/password-reset?token=');
    expect(row.payload.html).not.toContain(env.STOREFRONT_URL); // no brand-A env leak
  });

  it('a second store never sees the first store’s links', async () => {
    await seedCustomer(STORE_A, 'reset-me@a.test');
    await seedCustomer(STORE_B, 'reset-me@b.test');
    await app.request('/v1/shop/auth/forgot-password', { method: 'POST', headers: hdr(SLUG_A), body: JSON.stringify({ email: 'reset-me@a.test' }) });
    await app.request('/v1/shop/auth/forgot-password', { method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ email: 'reset-me@b.test' }) });
    const [a] = await outbox(STORE_A);
    const [b] = await outbox(STORE_B);
    expect(a!.payload.from).toBe('orders@a-brand.example');
    expect(a!.payload.html).toContain('https://a-brand.example/password-reset?token=');
    expect(b!.payload.from).toBe('orders@b-brand.example');
    expect(b!.payload.html).toContain('https://b-brand.example/password-reset?token=');
    expect(b!.payload.html).not.toContain('a-brand.example');
  });

  it('always 200 for an unknown email (no enumeration, no row)', async () => {
    const res = await app.request('/v1/shop/auth/forgot-password', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ email: 'ghost@b.test' }),
    });
    expect(res.status).toBe(200);
    expect(await outbox(STORE_B)).toHaveLength(0);
  });
});

describe('Turnstile enforcement (PAR-06 wiring)', () => {
  it('blocks register when the configured store’s verification fails', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(false);
    const res = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(SLUG_T), body: JSON.stringify({ email: 'bot@t.test', password: 'botpassword1' }),
    });
    expect(res.status).toBe(403);
    expect(verifyTurnstileToken).toHaveBeenCalledWith(expect.objectContaining({ secret: 'cf-secret-1' }));
    const n = await withStore(STORE_T, async (tx) => (await tx.select({ id: s.customer.id }).from(s.customer)).length);
    expect(n).toBe(0); // fail closed — no account created
  });

  it('blocks login + forgot-password the same way', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(false);
    const login = await app.request('/v1/shop/auth/login', {
      method: 'POST', headers: hdr(SLUG_T), body: JSON.stringify({ email: 'x@t.test', password: 'whatever123' }),
    });
    const forgot = await app.request('/v1/shop/auth/forgot-password', {
      method: 'POST', headers: hdr(SLUG_T), body: JSON.stringify({ email: 'x@t.test' }),
    });
    expect(login.status).toBe(403);
    expect(forgot.status).toBe(403);
  });

  it('passes through when verification succeeds', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(true);
    const res = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(SLUG_T), body: JSON.stringify({ email: 'human@t.test', password: 'humanpassword1', turnstileToken: 'cf-token' }),
    });
    expect(res.status).toBe(200);
    expect(verifyTurnstileToken).toHaveBeenCalledWith(expect.objectContaining({ secret: 'cf-secret-1', token: 'cf-token' }));
  });

  it('stores WITHOUT a secret never call the verifier (feature off)', async () => {
    vi.mocked(verifyTurnstileToken).mockClear();
    const res = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ email: 'plain@b.test', password: 'plainpassword1' }),
    });
    expect(res.status).toBe(200);
    expect(verifyTurnstileToken).not.toHaveBeenCalled();
  });
});

describe('register → verify-email is durable + store-branded (SR-05/SR-12)', () => {
  it('enqueues email_verify into the outbox with the store’s sender + URL', async () => {
    const res = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ email: 'newbie@b.test', password: 'newbiepassword1' }),
    });
    expect(res.status).toBe(200);
    const rows = await outbox(STORE_B);
    const v = rows.find((r) => r.kind === 'email_verify');
    expect(v).toBeDefined();
    expect(v!.recipient).toBe('newbie@b.test');
    expect(v!.payload.from).toBe('orders@b-brand.example');
    expect(v!.payload.html).toContain('https://b-brand.example/verify?token=');
    expect(v!.payload.html).not.toContain(env.STOREFRONT_URL);
  });
});

describe('email-address-change flow (emailAddressChangeHandler parity)', () => {
  async function requestChange(token: string, newEmail: string, password = 'correcthorsebattery') {
    return app.request('/v1/shop/auth/request-email-change', {
      method: 'POST', headers: hdr(SLUG_B, { authorization: `Bearer ${token}` }),
      body: JSON.stringify({ newEmail, password }),
    });
  }

  async function sessionFor(storeId: string, customerId: string): Promise<string> {
    return withStore(storeId, (tx) => createSession(tx, storeId, customerId));
  }

  function tokenFrom(row: OutboxRow): string {
    const m = /verify-email-address-change\?token=([A-Za-z0-9_-]+)/.exec(row.payload.html ?? '');
    expect(m).toBeTruthy();
    return m![1]!;
  }

  it('waits for customer before locking an email-change token when no orders exist', async () => {
    const cust = await seedCustomer(STORE_B, 'lock-order-old@b.test');
    const raw = 'email-change-customer-before-token';
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    await withStore(STORE_B, (tx) => tx.insert(s.customerToken).values({
      storeId: STORE_B, customerId: cust.id, kind: 'email_change', tokenHash,
      expiresAt: new Date(Date.now() + 3600_000), payload: { newEmail: 'lock-order-new@b.test' },
    }));
    const blocker = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query("SET LOCAL statement_timeout = '10s'");
      await blocker.query("SELECT set_config('app.current_store', $1, true)", [STORE_B]);
      const { rows: backends } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await blocker.query('SELECT id FROM customer WHERE id = $1 FOR UPDATE', [cust.id]);
      pending = Promise.resolve(app.request('/v1/shop/auth/verify-email-change', {
        method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: raw }),
      }));

      let customerWait = false;
      const deadline = Date.now() + 3500;
      do {
        const { rows } = await pool.query<{ query: string }>(`
          SELECT query FROM pg_stat_activity
          WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
            AND wait_event_type = 'Lock'`, [backends[0]!.pid]);
        customerWait = rows.some((row) => /customer/.test(row.query) && /for update/i.test(row.query));
        if (!customerWait) await new Promise((resolve) => setTimeout(resolve, 15));
      } while (!customerWait && Date.now() < deadline);
      expect(customerWait).toBe(true);

      // No commerce rows mask the order: the customer wait must leave the token
      // entirely unlocked, so an independent NOWAIT claim can still take it.
      const probe = await pool.connect();
      try {
        await probe.query('BEGIN');
        await probe.query("SET LOCAL statement_timeout = '1s'");
        await probe.query("SELECT set_config('app.current_store', $1, true)", [STORE_B]);
        const available = await probe.query<{ used_at: Date | null }>(
          'SELECT used_at FROM customer_token WHERE store_id = $1 AND token_hash = $2 FOR UPDATE NOWAIT', [STORE_B, tokenHash]);
        expect(available.rows).toEqual([{ used_at: null }]);
      } finally {
        try { await probe.query('ROLLBACK'); } finally { probe.release(); }
      }
      await blocker.query('ROLLBACK');
      expect((await pending).status).toBe(200);
      expect((await pool.query('SELECT email, email_verified FROM customer WHERE id = $1', [cust.id])).rows)
        .toEqual([{ email: 'lock-order-new@b.test', email_verified: true }]);
      expect((await pool.query('SELECT used_at FROM customer_token WHERE token_hash = $1', [tokenHash])).rows[0]!.used_at).not.toBeNull();
    } finally {
      try {
        await blocker.query('ROLLBACK');
      } finally {
        blocker.release();
        if (pending) await Promise.allSettled([pending]);
      }
    }
  }, 30000);

  it('requires auth and the current password', async () => {
    const cust = await seedCustomer(STORE_B, 'old@b.test');
    const unauth = await app.request('/v1/shop/auth/request-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ newEmail: 'n1@b.test', password: 'correcthorsebattery' }),
    });
    expect(unauth.status).toBe(401);
    const token = await sessionFor(STORE_B, cust.id);
    const wrong = await requestChange(token, 'n2@b.test', 'nottherightpassword');
    expect(wrong.status).toBe(401);
    expect(await outbox(STORE_B)).toHaveLength(0);
  });

  it('keeps one credential budget when destinations rotate, including concurrent guesses', async () => {
    const cust = await seedCustomer(STORE_B, 'rotating-destinations@b.test');
    const token = await sessionFor(STORE_B, cust.id);
    const spy = vi.spyOn(passwordAuth, 'verifyPassword');
    try {
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        requestChange(token, `rotated-${i}@b.test`, 'wrong-password')));
      expect(results.filter((r) => r.status === 401)).toHaveLength(8);
      expect(results.filter((r) => r.status === 429)).toHaveLength(4);
      expect(spy).toHaveBeenCalledTimes(8);
      expect((await requestChange(token, 'another-new-destination@b.test')).status).toBe(429);
      expect(spy).toHaveBeenCalledTimes(8);
      expect(await outbox(STORE_B)).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });

  it('bounds invalid sessions by tenant/IP without password work or raw-token keys', async () => {
    const backend = createMemoryRateLimitBackend();
    const consume = vi.spyOn(backend, 'consume');
    _setRateLimitBackendForTest(backend);
    const spy = vi.spyOn(passwordAuth, 'verifyPassword');
    try {
      for (let i = 0; i < 50; i++) {
        expect((await requestChange(`unknown-session-${i}`, `invalid-${i}@b.test`)).status).toBe(401);
      }
      expect((await requestChange('unknown-session-51', 'invalid-51@b.test')).status).toBe(429);
      expect(spy).not.toHaveBeenCalled();
      expect(consume.mock.calls).toHaveLength(51);
      for (const [bucket, key] of consume.mock.calls) {
        expect(bucket).toBe('customer-email-change-ip');
        expect(key).toContain(STORE_B);
        expect(key).not.toContain('unknown-session');
      }
    } finally { spy.mockRestore(); consume.mockRestore(); }
  });

  it('reserves credential attempts without holding a store transaction connection', async () => {
    const cust = await seedCustomer(STORE_B, 'pool-safe@b.test');
    const token = await sessionFor(STORE_B, cust.id);
    const backend = createMemoryRateLimitBackend();
    const original = backend.consume.bind(backend);
    const consume = vi.spyOn(backend, 'consume').mockImplementation(async (...args) => {
      expect(pool.totalCount - pool.idleCount).toBe(0);
      return original(...args);
    });
    _setRateLimitBackendForTest(backend);
    expect((await requestChange(token, 'pool-safe-new@b.test')).status).toBe(200);
    expect(consume).toHaveBeenCalledTimes(2); // IP ceiling, then validated customer budget
  });

  async function plantReset(customerId: string, raw: string) {
    await withStore(STORE_B, (tx) => tx.insert(s.customerToken).values({
      storeId: STORE_B, customerId, kind: 'password_reset',
      tokenHash: createHash('sha256').update(raw).digest('hex'), expiresAt: new Date(Date.now() + 3600_000),
    }));
  }

  const reset = (raw: string) => Promise.resolve(app.request('/v1/shop/auth/reset-password', {
    method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: raw, password: 'recovered-password' }),
  }));
  const consumeChange = (raw: string) => Promise.resolve(app.request('/v1/shop/auth/verify-email-change', {
    method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: raw }),
  }));

  async function lockCustomer(client: PoolClient, customerId: string): Promise<number> {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SELECT set_config('app.current_store', $1, true)", [STORE_B]);
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await client.query('SELECT id FROM customer WHERE id = $1 FOR UPDATE', [customerId]);
    return rows[0]!.pid;
  }

  async function waitForCustomerWaiters(blockerPid: number, count: number) {
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

  it('password recovery invalidates a previously prepared email-change link', async () => {
    const cust = await seedCustomer(STORE_B, 'recover-old@b.test');
    const session = await sessionFor(STORE_B, cust.id);
    expect((await requestChange(session, 'recover-attacker@b.test')).status).toBe(200);
    const raw = tokenFrom((await outbox(STORE_B))[0]!);
    const resetRaw = 'recover-password-reset-token';
    await plantReset(cust.id, resetRaw);
    expect((await reset(resetRaw)).status).toBe(200);
    expect((await consumeChange(raw)).status).toBe(409);
    expect((await requestChange(session, 'recover-after@b.test')).status).toBe(401);
    const after = await pool.query('SELECT email, password_hash FROM customer WHERE id = $1', [cust.id]);
    expect(after.rows[0]!.email).toBe('recover-old@b.test');
    expect(await passwordAuth.verifyPassword('recovered-password', after.rows[0]!.password_hash)).toBe(true);
  });

  for (const first of ['reset', 'issue'] as const) {
    it(`serializes reset vs issuance when ${first} holds customer lock first`, async () => {
      const cust = await seedCustomer(STORE_B, 'issue-race-old@b.test');
      const session = await sessionFor(STORE_B, cust.id);
      const resetRaw = 'issue-race-password-reset-token';
      await plantReset(cust.id, resetRaw);
      const blocker = await pool.connect();
      let issueRequest: Promise<Response> | undefined;
      let resetRequest: Promise<Response> | undefined;
      const issue = () => Promise.resolve(requestChange(session, 'issue-race-new@b.test'));
      try {
        const blockerPid = await lockCustomer(blocker, cust.id);
        if (first === 'reset') resetRequest = reset(resetRaw);
        else issueRequest = issue();
        await waitForCustomerWaiters(blockerPid, 1);
        if (first === 'reset') issueRequest = issue();
        else resetRequest = reset(resetRaw);
        await waitForCustomerWaiters(blockerPid, 2);
        await blocker.query('COMMIT');
        expect((await resetRequest!).status).toBe(200);
        expect((await issueRequest!).status).toBe(first === 'reset' ? 401 : 200);
        expect((await pool.query('SELECT email FROM customer WHERE id = $1', [cust.id])).rows[0]!.email).toBe('issue-race-old@b.test');
        const pending = await pool.query("SELECT id FROM customer_token WHERE customer_id = $1 AND kind = 'email_change' AND used_at IS NULL", [cust.id]);
        expect(pending.rows).toHaveLength(0);
        const messages = (await outbox(STORE_B)).filter((r) => r.kind === 'email_change');
        expect(messages).toHaveLength(first === 'reset' ? 0 : 1);
        if (messages.length) expect((await consumeChange(tokenFrom(messages[0]!))).status).toBe(409);
        expect((await pool.query('SELECT id FROM "session" WHERE customer_id = $1', [cust.id])).rows).toHaveLength(0);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
        await Promise.allSettled([issueRequest, resetRequest]);
      }
    }, 30_000);
  }

  for (const first of ['reset', 'consume'] as const) {
    it(`serializes reset vs redemption when ${first} holds customer lock first`, async () => {
      const cust = await seedCustomer(STORE_B, 'consume-race-old@b.test');
      const session = await sessionFor(STORE_B, cust.id);
      expect((await requestChange(session, 'consume-race-new@b.test')).status).toBe(200);
      const raw = tokenFrom((await outbox(STORE_B))[0]!);
      const resetRaw = 'consume-race-password-reset-token';
      await plantReset(cust.id, resetRaw);
      const blocker = await pool.connect();
      let consumeRequest: Promise<Response> | undefined;
      let resetRequest: Promise<Response> | undefined;
      try {
        const blockerPid = await lockCustomer(blocker, cust.id);
        if (first === 'reset') resetRequest = reset(resetRaw);
        else consumeRequest = consumeChange(raw);
        await waitForCustomerWaiters(blockerPid, 1);
        if (first === 'reset') consumeRequest = consumeChange(raw);
        else resetRequest = reset(resetRaw);
        await waitForCustomerWaiters(blockerPid, 2);
        await blocker.query('COMMIT');
        expect((await resetRequest!).status).toBe(first === 'reset' ? 200 : 409);
        expect((await consumeRequest!).status).toBe(first === 'reset' ? 409 : 200);
        const after = (await pool.query('SELECT email, password_hash FROM customer WHERE id = $1', [cust.id])).rows[0]!;
        expect(after.email).toBe(first === 'reset' ? 'consume-race-old@b.test' : 'consume-race-new@b.test');
        expect(await passwordAuth.verifyPassword(first === 'reset' ? 'recovered-password' : 'correcthorsebattery', after.password_hash)).toBe(true);
        expect((await consumeChange(raw)).status).toBe(409);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
        await Promise.allSettled([consumeRequest, resetRequest]);
      }
    }, 30_000);
  }

  it('sends the verification link to the NEW address, branded for the store', async () => {
    const cust = await seedCustomer(STORE_B, 'old@b.test');
    const token = await sessionFor(STORE_B, cust.id);
    const res = await requestChange(token, 'new@b.test');
    expect(res.status).toBe(200);
    const rows = await outbox(STORE_B);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('email_change');
    expect(row.recipient).toBe('new@b.test');
    expect(row.payload.from).toBe('orders@b-brand.example');
    expect(row.payload.html).toContain('https://b-brand.example/verify-email-address-change?token=');
    expect(row.payload.html).not.toContain(env.STOREFRONT_URL);
  });

  it('verify-email-change flips the email, verifies it, kills sessions, is single-use', async () => {
    const cust = await seedCustomer(STORE_B, 'old@b.test');
    const token = await sessionFor(STORE_B, cust.id);
    await requestChange(token, 'new@b.test');
    const [row] = await outbox(STORE_B);
    const raw = tokenFrom(row!);

    const res = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: raw }),
    });
    expect(res.status).toBe(200);

    const after = await withStore(STORE_B, async (tx) => {
      const [c] = await tx.select().from(s.customer).where(eq(s.customer.id, cust.id)).limit(1);
      const sessions = await tx.select({ id: s.session.id }).from(s.session).where(eq(s.session.customerId, cust.id));
      const tok = await tx.execute(sql`SELECT used_at FROM customer_token WHERE token_hash = ${createHash('sha256').update(raw).digest('hex')}`);
      return { c, sessions, tok: tok.rows[0] as { used_at: Date | null } | undefined };
    });
    expect(after.c!.email).toBe('new@b.test');
    expect(after.c!.emailVerified).toBe(true);
    expect(after.sessions).toHaveLength(0); // session invalidated
    expect(after.tok!.used_at).not.toBeNull();

    // Replay → single-use guard rejects.
    const replay = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: raw }),
    });
    expect(replay.status).toBe(409);
  });

  it('notifies the OLD (abandoned) address once the change is confirmed, unconditionally', async () => {
    const cust = await seedCustomer(STORE_B, 'old@b.test');
    const token = await sessionFor(STORE_B, cust.id);
    await requestChange(token, 'new@b.test');
    const [reqRow] = await outbox(STORE_B);
    const raw = tokenFrom(reqRow!);
    // Only the request-time mail (to the NEW address) exists before confirm.
    expect(await outbox(STORE_B)).toHaveLength(1);

    const res = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: raw }),
    });
    expect(res.status).toBe(200);

    const rows = await outbox(STORE_B);
    expect(rows).toHaveLength(2);
    const notice = rows.find((r) => r.kind === 'email_changed_notice');
    expect(notice).toBeDefined();
    expect(notice!.recipient).toBe('old@b.test'); // the ABANDONED address, not the new one
    expect(notice!.payload.html).toContain('new@b.test');
    expect(notice!.payload.html).toMatch(/did not make this change/i);

    // Audit log records the previous email alongside the new one.
    const audit = await withStore(STORE_B, (tx) =>
      tx.execute(sql`SELECT data FROM audit_log WHERE entity = 'customer' AND action = 'email_changed' AND entity_id = ${cust.id}`));
    expect((audit.rows[0] as { data: { previousEmail?: string } }).data.previousEmail).toBe('old@b.test');
  });

  it('rejects expired and bogus tokens', async () => {
    const cust = await seedCustomer(STORE_B, 'old2@b.test');
    const token = await sessionFor(STORE_B, cust.id);
    await requestChange(token, 'newer@b.test');
    const [row] = await outbox(STORE_B);
    const raw = tokenFrom(row!);
    await withStore(STORE_B, async (tx) => {
      await tx.execute(sql`UPDATE customer_token SET expires_at = now() - interval '1 hour' WHERE kind = 'email_change'`);
    });
    const res = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: raw }),
    });
    expect(res.status).toBe(409);
    const bogus = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: 'bogus-token-that-is-long-enough' }),
    });
    expect(bogus.status).toBe(409);
  });

  it('a newer request supersedes outstanding links; email taken → 409', async () => {
    const cust = await seedCustomer(STORE_B, 'old3@b.test');
    await seedCustomer(STORE_B, 'taken@b.test');
    const token = await sessionFor(STORE_B, cust.id);
    // taken address
    expect((await requestChange(token, 'taken@b.test')).status).toBe(409);
    // two outstanding requests — first link dies when the second is minted
    await requestChange(token, 'first@b.test');
    await requestChange(token, 'second@b.test');
    const rows = await outbox(STORE_B);
    const first = rows.find((r) => r.recipient === 'first@b.test')!;
    const second = rows.find((r) => r.recipient === 'second@b.test')!;
    const firstVerify = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: tokenFrom(first) }),
    });
    expect(firstVerify.status).toBe(409); // superseded
    const secondVerify = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: tokenFrom(second) }),
    });
    expect(secondVerify.status).toBe(200);
  });
});

describe('POST /v1/shop/auth/reset-password — atomic claim (security audit 2026-10-15)', () => {
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  async function plantReset(customerId: string, raw: string) {
    await withStore(STORE_A, (tx) => tx.insert(s.customerToken).values({ storeId: STORE_A, customerId, kind: 'password_reset', tokenHash: sha(raw), expiresAt: new Date(Date.now() + 3600_000) }));
  }
  const reset = (token: string, password: string) => app.request('/v1/shop/auth/reset-password', { method: 'POST', headers: hdr(SLUG_A), body: JSON.stringify({ token, password }) });
  const login = (email: string, password: string) => app.request('/v1/shop/auth/login', { method: 'POST', headers: hdr(SLUG_A), body: JSON.stringify({ email, password }) });

  it('two concurrent redemptions of ONE token: exactly one succeeds, and the password is the winner\'s', async () => {
    const c = await seedCustomer(STORE_A, 'race@a.test');
    const raw = 'r'.repeat(40);
    await plantReset(c.id, raw);
    const [a, b] = await Promise.all([reset(raw, 'first-new-password'), reset(raw, 'second-new-password')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? 'first-new-password' : 'second-new-password';
    const loser = a.status === 200 ? 'second-new-password' : 'first-new-password';
    expect((await login('race@a.test', winner)).status).toBe(200);
    expect((await login('race@a.test', loser)).status).toBe(401);
  });

  it('a reset burns the customer\'s OTHER outstanding reset tokens and revokes their sessions', async () => {
    const c = await seedCustomer(STORE_A, 'siblings@a.test');
    const t1 = 's'.repeat(40); const t2 = 't'.repeat(40);
    await plantReset(c.id, t1); await plantReset(c.id, t2);
    const session = await withStore(STORE_A, (tx) => createSession(tx, STORE_A, c.id));
    expect((await reset(t1, 'brand-new-password-1')).status).toBe(200);
    expect((await reset(t2, 'attacker-password-2')).status).toBe(409); // an older link cannot undo the reset
    expect((await login('siblings@a.test', 'brand-new-password-1')).status).toBe(200);
    const live = await pool.query('SELECT 1 FROM "session" WHERE token_hash = $1', [sha(session)]);
    expect(live.rowCount).toBe(0);
  });

  it('two DIFFERENT reset tokens for the same customer redeemed concurrently: one 200, one 409, never a 500/deadlock', async () => {
    const c = await seedCustomer(STORE_A, 'pair@a.test');
    const t1 = 'p'.repeat(40); const t2 = 'q'.repeat(40);
    await plantReset(c.id, t1); await plantReset(c.id, t2);
    for (let round = 0; round < 3; round++) {
      if (round > 0) { await plantReset(c.id, `${t1}${round}`); await plantReset(c.id, `${t2}${round}`); }
      const sfx = round > 0 ? String(round) : '';
      const [a, b] = await Promise.all([reset(`${t1}${sfx}`, 'pair-new-password-a'), reset(`${t2}${sfx}`, 'pair-new-password-b')]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    }
  });

  it('rechecks expiry after slow password hashing before the locked claim', async () => {
    const customer = await seedCustomer(STORE_A, 'expiry-wait@a.test');
    const raw = 'expires-while-customer-is-locked';
    await plantReset(customer.id, raw);
    let entered!: () => void;
    let resume!: () => void;
    const blocked = new Promise<void>((r) => { entered = r; });
    const release = new Promise<void>((r) => { resume = r; });
    const original = passwordAuth.hashPassword;
    const spy = vi.spyOn(passwordAuth, 'hashPassword').mockImplementationOnce(async (...args) => {
      const hash = await original(...args);
      entered();
      await release;
      return hash;
    });
    const pending = reset(raw, 'changed-after-token-expiry');
    try {
      await blocked;
      // The cheap probe has completed, but token expiry changes before the locked claim.
      await pool.query('UPDATE customer_token SET expires_at = $1 WHERE token_hash = $2', [new Date(Date.now() - 1), sha(raw)]);
      const before = (await pool.query('SELECT password_hash FROM customer WHERE id = $1', [customer.id])).rows;
      resume();
      expect((await pending).status).toBe(409);
      expect((await pool.query('SELECT password_hash FROM customer WHERE id = $1', [customer.id])).rows).toEqual(before);
      expect((await pool.query('SELECT used_at FROM customer_token WHERE token_hash = $1', [sha(raw)])).rows[0].used_at).toBeNull();
    } finally { resume(); spy.mockRestore(); await pending; }
  });

  it('an invalid or used token changes nothing', async () => {
    await seedCustomer(STORE_A, 'nochange@a.test', 'original-password-1');
    expect((await reset('u'.repeat(40), 'whatever-password')).status).toBe(409);
    expect((await login('nochange@a.test', 'original-password-1')).status).toBe(200);
  });
});
