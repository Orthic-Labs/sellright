/**
 * P1a regression (security audit 2026-10-15): admin login abuse. Real app (createApp), real DB
 * (sellright_test ONLY — TRUNCATEs), memory rate-limit backend reset per case.
 *
 * Before: the only limiter was 8 failures / 15 min per (ip, account) — rotating IPs ground one
 * account forever, one IP sprayed unlimited accounts, unknown e-mails skipped Argon2 (timing
 * oracle), any client picked its own "IP" via X-Real-IP (the socket address was never read), and
 * /2fa/enable, /2fa/disable were not limited at all.
 */
import { isDisposablePostgresUrl } from './db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

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
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend, createPostgresRateLimitBackend } from './auth/rate-limit-backend.js';
import { newTotpSecret } from './auth/totp.js';

const isTestDb = isDisposablePostgresUrl(process.env.DATABASE_URL ?? env.DATABASE_URL);
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
    expect((await authed(token, '/v1/admin/2fa/enable', { secret, code: '000000', password: PASSWORD })).status).toBe(429);
  });

  it('wrong 2FA codes on enable/disable are counted (a hijacked session cannot grind the current code)', async () => {
    const token = await createAdminSession(ADMIN);
    await pool.query('UPDATE admin_user SET totp_secret = $1 WHERE id = $2', [newTotpSecret(), ADMIN]);
    let last = 0;
    const secret = (await pool.query('SELECT totp_secret FROM admin_user WHERE id = $1', [ADMIN])).rows[0].totp_secret as string;
    const live = new Set([-1, 0, 1].map((d) => currentTotp(secret, d)));
    const wrong = ['000000', '111111', '222222', '333333'].find((c) => !live.has(c))!; // never a code that is valid right now
    for (let i = 0; i < 9; i++) last = (await authed(token, '/v1/admin/2fa/disable', { code: wrong, password: PASSWORD }, '198.51.100.240')).status;
    expect(last).toBe(429);
  });

  it('a concurrent burst of guesses is held to the budget (attempts are reserved before verification, shared Postgres backend)', async () => {
    await pool.query(`DELETE FROM rate_limit_attempt WHERE key LIKE '%198.51.100.123%' OR key = 'admin:owner@abuse.test'`);
    _setRateLimitBackendForTest(createPostgresRateLimitBackend());
    const res = await Promise.all(Array.from({ length: 16 }, () => login(EMAIL, 'wrong-password', '198.51.100.123')));
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((x) => x === 401)).toHaveLength(8);
    expect(statuses.filter((x) => x === 429)).toHaveLength(8);
  });

  it('enrolling an authenticator from a stolen session does not reset the password-guessing budget', async () => {
    const token = await createAdminSession(ADMIN);
    for (let i = 0; i < 7; i++) expect((await authed(token, '/v1/admin/step-up', { password: `guess-${i}` }, '198.51.100.200')).status).toBe(401);
    const secret = newTotpSecret();
    const { verifyTotp } = await import('./auth/totp.js');
    const code = currentTotp(secret);
    expect(verifyTotp(secret, code)).toBe(true);
    // P1b: enrolling also re-proves the password — a stolen session without it is refused, and that try is counted too
    expect((await authed(token, '/v1/admin/2fa/enable', { secret, code, password: 'guess-7' }, '198.51.100.200')).status).toBe(401);
    // the 8 password guesses (7 step-ups + the enrolment attempt) are still counted: the next guess is refused
    expect((await authed(token, '/v1/admin/step-up', { password: 'guess-8' }, '198.51.100.200')).status).toBe(429);
  });
});

function currentTotp(secretB32: string, drift = 0): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + drift));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1]! & 0xf;
  return ((((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000).toString().padStart(6, '0');
}

