/**
 * P1a regression (security audit 2026-10-15): admin login abuse. Real app (createApp), real DB
 * (sellright_test ONLY — TRUNCATEs), memory rate-limit backend reset per case.
 *
 * Before: the only limiter was 8 failures / 15 min per (ip, account) — rotating IPs ground one
 * account forever, one IP sprayed unlimited accounts, unknown e-mails skipped Argon2 (timing
 * oracle), any client picked its own "IP" via X-Real-IP (the socket address was never read), and
 * /2fa/enable, /2fa/disable were not limited at all.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spy = vi.hoisted(() => ({ dummy: 0 }));
vi.mock('./auth/password.js', async (orig) => {
  const real = await orig<typeof import('./auth/password.js')>();
  return { ...real, verifyPasswordAgainstDummy: async (p: string) => { spy.dummy++; return real.verifyPasswordAgainstDummy(p); } };
});

import { createApp } from './app.js';
import { pool } from './db/client.js';
import { env } from './env.js';
import { hashPassword } from './auth/password.js';
import { createAdminSession } from './auth/admin-session.js';
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from './auth/rate-limit-backend.js';
import { newTotpSecret } from './auth/totp.js';

const isTestDb = /^\/[^/]*_test$/.test(new URL(process.env.DATABASE_URL ?? env.DATABASE_URL).pathname); // the DB NAME, not the whole URL
const STORE = 'abababab-abab-abab-abab-ababababab01';
const ADMIN = 'abababab-abab-abab-abab-0000000000a1';
const EMAIL = 'owner@abuse.test';
const PASSWORD = 'correct-horse-battery';
const app = createApp();

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

function login(email: string, password: string, ip?: string, socket?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ip) headers['x-real-ip'] = ip;
  const envArg = socket ? { incoming: { socket: { remoteAddress: socket } } } : undefined;
  return app.request('/v1/admin/login', { method: 'POST', headers, body: JSON.stringify({ email, password }) }, envArg);
}
function authed(token: string, path: string, body: unknown, ip = '198.51.100.250') {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-real-ip': ip }, body: JSON.stringify(body) });
}

beforeEach(async () => {
  if (!isTestDb) return;
  _setRateLimitBackendForTest(createMemoryRateLimitBackend());
  spy.dummy = 0;
  await wipe();
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'abuse', 'Abuse', 'USD')`, [STORE]);
  await pool.query(`INSERT INTO admin_user (id, email, password_hash) VALUES ($1, $2, $3)`, [ADMIN, EMAIL, await hashPassword(PASSWORD)]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [ADMIN, STORE]);
});
afterAll(async () => { if (isTestDb) await wipe(); _setRateLimitBackendForTest(undefined); await pool.end(); });

describe.skipIf(!isTestDb)('P1a: admin login abuse', () => {
  it('per account across IPs: 20 failures from 20 IPs lock the account, even for the right password from a fresh IP', async () => {
    for (let i = 0; i < 20; i++) expect((await login(EMAIL, 'wrong-password', `198.51.100.${i + 1}`)).status).toBe(401);
    const res = await login(EMAIL, PASSWORD, '192.0.2.77');
    expect(res.status).toBe(429);
  });

  it('per IP across e-mails: 50 failures over 50 addresses throttle that IP for every account', async () => {
    for (let i = 0; i < 50; i++) expect((await login(`nobody${i}@abuse.test`, 'x', '198.51.100.9')).status).toBe(401);
    expect((await login(EMAIL, PASSWORD, '198.51.100.9')).status).toBe(429);
    expect((await login(EMAIL, PASSWORD, '198.51.100.10')).status).toBe(200);
  });

  it('a direct public client cannot mint a fresh identity per request with X-Real-IP: the socket address counts', async () => {
    for (let i = 0; i < 8; i++) expect((await login(EMAIL, 'wrong', `10.0.${i}.1`, '203.0.113.50')).status).toBe(401);
    expect((await login(EMAIL, PASSWORD, '10.99.99.99', '203.0.113.50')).status).toBe(429);
  });

  it('unknown e-mails run a dummy Argon2 verification (no timing oracle) and get the same 401', async () => {
    const res = await login('ghost@abuse.test', 'whatever');
    expect(res.status).toBe(401);
    expect(spy.dummy).toBe(1);
    const known = await login(EMAIL, 'wrong-password');
    expect(known.status).toBe(401);
    expect(spy.dummy).toBe(1); // a real account verifies against its own hash
    type Err = { error: { message: string } };
    expect(((await res.json()) as Err).error.message).toBe(((await known.json()) as Err).error.message);
  });

  it('step-up, 2FA enable and 2FA disable share the per-account budget and answer 429 once it is spent', async () => {
    const token = await createAdminSession(ADMIN);
    for (let i = 0; i < 20; i++) await login(EMAIL, 'wrong-password', `198.51.100.${i + 1}`);
    expect((await authed(token, '/v1/admin/step-up', { password: PASSWORD })).status).toBe(429);
    const secret = newTotpSecret();
    expect((await authed(token, '/v1/admin/2fa/enable', { secret, code: '000000' })).status).toBe(429);
  });

  it('wrong 2FA codes on enable/disable are counted (a hijacked session cannot grind the current code)', async () => {
    const token = await createAdminSession(ADMIN);
    await pool.query('UPDATE admin_user SET totp_secret = $1 WHERE id = $2', [newTotpSecret(), ADMIN]);
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await authed(token, '/v1/admin/2fa/disable', { code: '000000' }, '198.51.100.240')).status;
    expect(last).toBe(429);
  });
});
