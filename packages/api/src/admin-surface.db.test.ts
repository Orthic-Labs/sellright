/**
 * P2 (security audit 2026-10-15): admin API surface hardening. Real app, real DB (sellright_test ONLY — TRUNCATEs).
 *  - exact-origin CORS on /v1/admin (no suffix / subdomain / scheme / port wildcard)
 *  - app-wide body limit (413), larger only for the asset upload
 *  - /v1/admin without cookie or bearer is refused BEFORE body validation
 *  - validation failures (and ZodErrors thrown in handlers, e.g. /v1/licenses/*) answer a generic 400 envelope
 *  - login omits the token for cookie clients (explicit API clients ask with returnToken)
 *  - idle session timeout
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { pool } from './db/client.js';
import { env, adminPublicUrl } from './env.js';
import { hashPassword } from './auth/password.js';
import { createAdminSession } from './auth/admin-session.js';
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from './auth/rate-limit-backend.js';

const isTestDb = /^\/[^/]*_test$/.test(new URL(process.env.DATABASE_URL ?? env.DATABASE_URL).pathname);
const STORE = 'adadadad-adad-4dad-8dad-adadadadad01';
const OWNER = 'adadadad-adad-4dad-8dad-0000000000a1';
const PW = 'surface-owner-password-1';
const app = createApp();

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}
beforeEach(async () => {
  if (!isTestDb) return;
  _setRateLimitBackendForTest(createMemoryRateLimitBackend());
  await wipe();
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'surface', 'S', 'USD')`, [STORE]);
  await pool.query(`INSERT INTO admin_user (id, email, password_hash) VALUES ($1, 'owner@surface.test', $2)`, [OWNER, await hashPassword(PW)]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [OWNER, STORE]);
});
afterAll(async () => { if (isTestDb) await wipe(); _setRateLimitBackendForTest(undefined); await pool.end(); });

const adminOrigin = () => new URL(adminPublicUrl()).origin;

describe.skipIf(!isTestDb)('P2: exact-origin CORS on /v1/admin', () => {
  const preflight = (origin: string) => app.request('/v1/admin/me', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } });

  it('the admin origin itself is allowed (credentialed)', async () => {
    const res = await preflight(adminOrigin());
    expect(res.headers.get('access-control-allow-origin')).toBe(adminOrigin());
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('suffix, subdomain, scheme and port variants are all refused', async () => {
    const u = new URL(adminOrigin());
    const variants = [
      `${u.protocol}//${u.hostname}.evil.example`,
      `${u.protocol}//evil.${u.hostname}`,
      `${u.protocol === 'https:' ? 'http:' : 'https:'}//${u.host}`,
      `${u.protocol}//${u.hostname}:8443`,
      'null',
    ];
    for (const o of variants) expect((await preflight(o)).headers.get('access-control-allow-origin'), o).toBeNull();
  });
});

describe.skipIf(!isTestDb)('P2: request size and anonymous admin requests', () => {
  it('an oversized body is refused with 413 before any handler', async () => {
    const big = JSON.stringify({ email: 'x@surface.test', password: 'x'.repeat(env.API_BODY_LIMIT_BYTES + 10) });
    const res = await app.request('/v1/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(big.length) }, body: big });
    expect(res.status).toBe(413);
  });

  it('an anonymous /v1/admin request is 401 before body validation (no schema hints)', async () => {
    const res = await app.request('/v1/admin/products', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name": 42}' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string }; success?: unknown };
    expect(body.error.code).toBe('NOT_AUTHENTICATED');
    expect(body).not.toHaveProperty('success');
  });

  it('pre-session routes stay reachable anonymously', async () => {
    const res = await app.request('/v1/admin/staff/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope', password: 'whatever-123' }) });
    expect(res.status).toBe(409);
  });
});

describe.skipIf(!isTestDb)('P2: generic validation envelope', () => {
  it('an authenticated admin request with an invalid body gets 400 VALIDATION_ERROR, not the raw zod dump', async () => {
    const token = await createAdminSession(OWNER);
    const res = await app.request('/v1/admin/staff/invites', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-store-slug': 'surface' }, body: JSON.stringify({ email: 'not-an-email' }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; param?: string }; success?: unknown };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.param).toBe('email');
    expect(body).not.toHaveProperty('success');
  });

  it('/v1/licenses/* with a body that fails its schema is a 400, not a 500', async () => {
    for (const p of ['/v1/licenses/activate', '/v1/licenses/refresh', '/v1/licenses/deactivate', '/v1/licenses/trial']) {
      const res = await app.request(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-store-slug': 'surface' }, body: '{}' });
      expect(res.status, p).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code, p).toBe('VALIDATION_ERROR');
    }
  });
});

describe.skipIf(!isTestDb)('P2: login token and idle sessions', () => {
  it('a cookie client never gets the session token in the body; an explicit API client asks for it', async () => {
    const cookieClient = await app.request('/v1/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@surface.test', password: PW }) });
    expect(cookieClient.status).toBe(200);
    expect(await cookieClient.json()).not.toHaveProperty('token');
    expect(cookieClient.headers.getSetCookie().some((c) => c.startsWith('sr_admin=') && c.includes('HttpOnly'))).toBe(true);
    const apiClient = await app.request('/v1/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@surface.test', password: PW, returnToken: true }) });
    expect(((await apiClient.json()) as { token?: string }).token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a session idle for longer than ADMIN_SESSION_IDLE_HOURS is refused and removed; activity keeps it alive', async () => {
    const token = await createAdminSession(OWNER);
    const me = () => app.request('/v1/admin/me', { headers: { authorization: `Bearer ${token}` } });
    expect((await me()).status).toBe(200);
    await pool.query(`UPDATE "session" SET last_seen_at = now() - make_interval(hours => $1::int) WHERE admin_user_id = $2`, [Math.ceil(env.ADMIN_SESSION_IDLE_HOURS) - 1, OWNER]);
    expect((await me()).status).toBe(200); // still inside the window, and this use refreshes last_seen_at
    const seen = (await pool.query('SELECT last_seen_at FROM "session" WHERE admin_user_id = $1', [OWNER])).rows[0].last_seen_at as Date;
    expect(Date.now() - seen.getTime()).toBeLessThan(60_000);
    await pool.query(`UPDATE "session" SET last_seen_at = now() - make_interval(hours => $1::int) WHERE admin_user_id = $2`, [Math.ceil(env.ADMIN_SESSION_IDLE_HOURS) + 1, OWNER]);
    expect((await me()).status).toBe(401);
    expect((await pool.query('SELECT 1 FROM "session" WHERE admin_user_id = $1', [OWNER])).rowCount).toBe(0);
  });
});
