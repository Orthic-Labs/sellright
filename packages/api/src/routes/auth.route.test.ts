/**
 * TEST-1: DB integration tests for customer auth — POST /v1/shop/auth/register,
 * /login, /logout, and GET /check-email. Drives the real Hono handler through
 * app.request(), mirroring checkout-migration.test.ts's conventions (withStore
 * seeds, x-store-slug header, TRUNCATE store CASCADE wipe).
 *
 * No SMTP is configured in the test env, so register's verification email
 * no-ops (sendEmail logs + returns delivered:false) — no network call fires.
 *
 * The login-throttle store (auth/rate-limit.ts) is an in-memory Map shared
 * across the whole test process, keyed by ip+identifier. Since clientIp()
 * resolves to a constant 'unknown' with no trusted proxy header configured,
 * every test in this file shares the SAME ip bucket — so each test uses a
 * UNIQUE email/identifier to avoid bleeding rate-limit state between tests.
 *
 * Runs against sellright_test ONLY (these wipe data). vitest runs files
 * serially (fileParallelism: false).
 *
 * Covers:
 *   1. register creates a customer + session (200, cookies set)
 *   2. register rejects a duplicate email (409)
 *   3. login succeeds and sets cookies + CSRF
 *   4. login with a wrong password returns a generic 401 (no email-exists leak)
 *   5. GET /check-email is rate-limited after repeated probes
 *   6. logout requires a valid CSRF token; succeeds with one
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { auth } from './auth.js';
import { CUST_COOKIE, CUST_CSRF_COOKIE } from '../auth/cookies.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`auth.route test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'aaaaaaaa-2222-2222-2222-222222222222';
const SLUG = 'auth-route-test-store';

const app = new OpenAPIHono();
app.route('/', auth);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seedStore(): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD') ON CONFLICT (id) DO NOTHING`);
  });
}

beforeEach(async () => { await wipe(); await seedStore(); });
afterAll(async () => { await wipe(); await pool.end(); });

const hdr = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, ...extra });

/** Parse Set-Cookie headers into a {name: value} map (Hono/undici may fold
 *  multiple Set-Cookie into one header separated by comma-in-attribute quirks,
 *  so use getSetCookie() when available, falling back to a single header). */
function parseSetCookies(res: Response): Record<string, string> {
  const raw = typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
    ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
    : [res.headers.get('set-cookie') ?? ''];
  const out: Record<string, string> = {};
  for (const line of raw) {
    const first = line.split(';')[0] ?? '';
    const i = first.indexOf('=');
    if (i > 0) out[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
  return out;
}

describe('POST /v1/shop/auth/register', () => {
  it('creates a customer + session and sets auth cookies', async () => {
    const res = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ email: 'newbuyer@auth.test', password: 'correcthorsebattery' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; customer: { id: string; email: string; isMigrated: boolean } };
    expect(body.token).toBeTruthy();
    expect(body.customer.email).toBe('newbuyer@auth.test');
    expect(body.customer.isMigrated).toBe(false);

    const cookies = parseSetCookies(res);
    expect(cookies[CUST_COOKIE]).toBe(body.token);
    expect(cookies[CUST_CSRF_COOKIE]).toBeTruthy();

    const dbCustomer = await withStore(STORE, async (tx) => {
      const [c] = await tx.select().from(s.customer).where(eq(s.customer.email, 'newbuyer@auth.test')).limit(1);
      return c ?? null;
    });
    expect(dbCustomer).not.toBeNull();
    expect(dbCustomer!.passwordHash).toBeTruthy();
    expect(dbCustomer!.passwordHash).not.toBe('correcthorsebattery'); // hashed, not plaintext
  });

  it('rejects a duplicate email with 409', async () => {
    await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ email: 'dupe@auth.test', password: 'firstpassword1' }),
    });
    const res = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ email: 'dupe@auth.test', password: 'secondpassword2' }),
    });
    expect(res.status).toBe(409);

    const count = await withStore(STORE, async (tx) => {
      const rows = await tx.select().from(s.customer).where(eq(s.customer.email, 'dupe@auth.test'));
      return rows.length;
    });
    expect(count).toBe(1); // no duplicate row created
  });
});

describe('POST /v1/shop/auth/login', () => {
  async function registerDirect(email: string, password: string): Promise<void> {
    const res = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
  }

  it('logs in with correct credentials and sets cookies', async () => {
    await registerDirect('logintest@auth.test', 'rightpassword1');
    const res = await app.request('/v1/shop/auth/login', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ email: 'logintest@auth.test', password: 'rightpassword1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; customer: { email: string } };
    expect(body.customer.email).toBe('logintest@auth.test');
    const cookies = parseSetCookies(res);
    expect(cookies[CUST_COOKIE]).toBe(body.token);
    expect(cookies[CUST_CSRF_COOKIE]).toBeTruthy();
  });

  it('a wrong password returns a generic 401 (no account-existence leak)', async () => {
    await registerDirect('wrongpw@auth.test', 'correctpassword1');
    const res = await app.request('/v1/shop/auth/login', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ email: 'wrongpw@auth.test', password: 'totallywrongpassword' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid email or password');
  });

  it('an unknown email returns the SAME generic 401 as a wrong password', async () => {
    const res = await app.request('/v1/shop/auth/login', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ email: 'doesnotexist@auth.test', password: 'whatever12345' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid email or password');
  });
});

describe('GET /v1/shop/auth/check-email — rate limiting', () => {
  it('rate-limits after repeated probes from the same IP', async () => {
    // check-email counts EVERY probe (success or not) toward the throttle
    // bucket `checkemail:${ip}` — 8 failures/15min trips it. Fire 9 probes
    // with distinct emails so we're testing the IP bucket, not email reuse.
    let lastStatus = 200;
    for (let i = 0; i < 9; i++) {
      const res = await app.request(`/v1/shop/auth/check-email?email=probe${i}@auth.test`, { headers: hdr() });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});

describe('POST /v1/shop/auth/logout', () => {
  it('requires a valid CSRF token — rejects a mismatched one with 403', async () => {
    const reg = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ email: 'logout1@auth.test', password: 'logoutpassword1' }),
    });
    const cookies = parseSetCookies(reg);
    const res = await app.request('/v1/shop/auth/logout', {
      method: 'POST',
      headers: hdr({ cookie: `${CUST_COOKIE}=${cookies[CUST_COOKIE]}; ${CUST_CSRF_COOKIE}=${cookies[CUST_CSRF_COOKIE]}`, 'x-csrf-token': 'wrong-csrf-value' }),
    });
    expect(res.status).toBe(403);
  });

  it('succeeds with a matching CSRF token and clears the session', async () => {
    const reg = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ email: 'logout2@auth.test', password: 'logoutpassword2' }),
    });
    const regBody = await reg.json() as { token: string };
    const cookies = parseSetCookies(reg);
    const res = await app.request('/v1/shop/auth/logout', {
      method: 'POST',
      headers: hdr({ cookie: `${CUST_COOKIE}=${cookies[CUST_COOKIE]}; ${CUST_CSRF_COOKIE}=${cookies[CUST_CSRF_COOKIE]}`, 'x-csrf-token': cookies[CUST_CSRF_COOKIE]! }),
    });
    expect(res.status).toBe(200);

    // the session row is deleted — /me with the old token now fails
    const meRes = await app.request('/v1/shop/auth/me', { headers: hdr({ authorization: `Bearer ${regBody.token}` }) });
    expect(meRes.status).toBe(401);
  });

  it('a bearer-authenticated request is CSRF-exempt (API clients don\'t carry cookies)', async () => {
    const reg = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ email: 'logout3@auth.test', password: 'logoutpassword3' }),
    });
    const regBody = await reg.json() as { token: string };
    const res = await app.request('/v1/shop/auth/logout', {
      method: 'POST', headers: hdr({ authorization: `Bearer ${regBody.token}` }),
    });
    expect(res.status).toBe(200);
  });
});
