/**
 * P1b (security audit 2026-10-15): required TOTP, enrolment-only sessions, TOTP secret encryption at
 * rest, recovery codes, authenticated password change. Real app, real DB (sellright_test ONLY —
 * TRUNCATEs), memory rate-limit backend, a test-only SELLRIGHT_MASTER_KEY.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createApp } from './app.js';
import { pool } from './db/client.js';
import { env } from './env.js';
import { hashPassword } from './auth/password.js';
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from './auth/rate-limit-backend.js';
import { newTotpSecret } from './auth/totp.js';
import { openTotpSecret, sealLegacyTotpSecrets } from './auth/totp-secret.js';

const isTestDb = /^\/[^/]*_test$/.test(new URL(process.env.DATABASE_URL ?? env.DATABASE_URL).pathname);
const STORE = 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcd01';
const OWNER = 'cdcdcdcd-cdcd-cdcd-cdcd-0000000000a1';
const STAFF = 'cdcdcdcd-cdcd-cdcd-cdcd-0000000000a2';
const MANAGER = 'cdcdcdcd-cdcd-cdcd-cdcd-0000000000a3';
const PW = 'mfa-owner-password-1';
const app = createApp();
const prevKey = process.env.SELLRIGHT_MASTER_KEY;

/** RFC 6238 code for `step` (independent of the implementation under test). */
function totpAt(secretB32: string, step: number): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1]! & 0xf;
  return ((((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000).toString().padStart(6, '0');
}
const step = () => Math.floor(Date.now() / 30000);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-store-slug': 'mfa' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
async function login(email: string, password: string, totp?: string) {
  const res = await req('POST', '/v1/admin/login', { body: { email, password, totp, returnToken: true } });
  return { res, body: (await res.json()) as { token?: string; totpEnrollmentRequired?: boolean; error?: { code: string } } };
}
async function storedSecret(id: string): Promise<string | null> {
  return (await pool.query('SELECT totp_secret FROM admin_user WHERE id = $1', [id])).rows[0].totp_secret as string | null;
}
/** Enrol 2FA through the API exactly like the admin SPA does; returns the secret and the recovery codes. */
async function enrol(token: string, password = PW) {
  const { secret } = (await (await req('POST', '/v1/admin/2fa/setup', { token })).json()) as { secret: string };
  const res = await req('POST', '/v1/admin/2fa/enable', { token, body: { secret, code: totpAt(secret, step()), password } });
  expect(res.status).toBe(200);
  const { recoveryCodes } = (await res.json()) as { recoveryCodes: string[] };
  return { secret, recoveryCodes };
}

beforeAll(() => { process.env.SELLRIGHT_MASTER_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'; });
beforeEach(async () => {
  if (!isTestDb) return;
  _setRateLimitBackendForTest(createMemoryRateLimitBackend());
  await wipe();
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'mfa', 'MFA', 'USD')`, [STORE]);
  const h = await hashPassword(PW);
  await pool.query(`INSERT INTO admin_user (id, email, password_hash) VALUES ($1, 'owner@mfa.test', $4), ($2, 'staff@mfa.test', $4), ($3, 'manager@mfa.test', $4)`, [OWNER, STAFF, MANAGER, h]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $4, 'owner'), ($2, $4, 'staff'), ($3, $4, 'manager')`, [OWNER, STAFF, MANAGER, STORE]);
});
afterAll(async () => {
  if (prevKey === undefined) delete process.env.SELLRIGHT_MASTER_KEY; else process.env.SELLRIGHT_MASTER_KEY = prevKey;
  if (isTestDb) await wipe();
  _setRateLimitBackendForTest(undefined);
  await pool.end();
});

describe.skipIf(!isTestDb)('P1b: TOTP secret at rest', () => {
  it('a newly enrolled secret is stored sealed (enc1:), never as the base32 plaintext, and still verifies at login', async () => {
    const { token } = (await login('owner@mfa.test', PW)).body;
    const { secret } = await enrol(token!);
    const stored = (await storedSecret(OWNER))!;
    expect(stored.startsWith('enc1:')).toBe(true);
    expect(stored).not.toContain(secret);
    expect(openTotpSecret(OWNER, stored)).toBe(secret);
    expect((await login('owner@mfa.test', PW, totpAt(secret, step() + 1))).res.status).toBe(200);
  });

  it('a legacy plaintext secret keeps working, is sealed by the start-up sweep, and keeps working after', async () => {
    const secret = newTotpSecret();
    await pool.query('UPDATE admin_user SET totp_secret = $1 WHERE id = $2', [secret, OWNER]);
    expect((await login('owner@mfa.test', PW, totpAt(secret, step() - 1))).res.status).toBe(200);
    expect(await sealLegacyTotpSecrets()).toBe(1);
    expect((await storedSecret(OWNER))!.startsWith('enc1:')).toBe(true);
    expect(await sealLegacyTotpSecrets()).toBe(0); // idempotent
    expect((await login('owner@mfa.test', PW, totpAt(secret, step()))).res.status).toBe(200);
  });

  it('a sealed secret copied onto another admin does not verify (purpose-bound)', async () => {
    const { token } = (await login('owner@mfa.test', PW)).body;
    const { secret } = await enrol(token!);
    await pool.query('UPDATE admin_user SET totp_secret = (SELECT totp_secret FROM admin_user WHERE id = $1) WHERE id = $2', [OWNER, STAFF]);
    // fails closed: the GCM tag does not authenticate under the other admin's purpose -> 500, never a pass
    expect((await login('staff@mfa.test', PW, totpAt(secret, step() + 1))).res.status).toBe(500);
  });
});

describe.skipIf(!isTestDb)('P1b: enrolment and recovery codes', () => {
  it('enabling 2FA re-proves the current password: a hijacked session alone cannot enrol an attacker device', async () => {
    const { token } = (await login('owner@mfa.test', PW)).body;
    const { secret } = (await (await req('POST', '/v1/admin/2fa/setup', { token })).json()) as { secret: string };
    const res = await req('POST', '/v1/admin/2fa/enable', { token, body: { secret, code: totpAt(secret, step()), password: 'not-my-password' } });
    expect(res.status).toBe(401);
    expect(await storedSecret(OWNER)).toBeNull();
  });

  it('enable returns 10 one-time recovery codes; each signs in once, then is spent; step-up accepts one too', async () => {
    const { token } = (await login('owner@mfa.test', PW)).body;
    const { recoveryCodes } = await enrol(token!);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const c of recoveryCodes) expect(c).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    const hashes = (await pool.query('SELECT code_hash FROM admin_recovery_code WHERE admin_user_id = $1', [OWNER])).rows.map((r) => r.code_hash as string);
    expect(hashes).toHaveLength(10);
    for (const c of recoveryCodes) expect(hashes.join(',')).not.toContain(c.replace(/-/g, ''));

    expect((await login('owner@mfa.test', PW, recoveryCodes[0]!.toUpperCase())).res.status).toBe(200);
    expect((await login('owner@mfa.test', PW, recoveryCodes[0]!)).res.status).toBe(401); // spent
    const st = await req('POST', '/v1/admin/step-up', { token, body: { password: PW, totp: recoveryCodes[1] } });
    expect(st.status).toBe(200);
    const status = (await (await req('GET', '/v1/admin/2fa', { token })).json()) as { enabled: boolean; recoveryCodesRemaining: number };
    expect(status).toMatchObject({ enabled: true, recoveryCodesRemaining: 8 });
  });

  it('disable needs the current password AND a code; it also drops the recovery codes', async () => {
    const { token } = (await login('owner@mfa.test', PW)).body;
    const { secret } = await enrol(token!);
    expect((await req('POST', '/v1/admin/2fa/disable', { token, body: { code: totpAt(secret, step() + 1), password: 'wrong-password' } })).status).toBe(401);
    expect((await req('POST', '/v1/admin/2fa/disable', { token, body: { code: '000000', password: PW } })).status).toBe(409);
    expect((await req('POST', '/v1/admin/2fa/disable', { token, body: { code: totpAt(secret, step() + 1), password: PW } })).status).toBe(200);
    expect(await storedSecret(OWNER)).toBeNull();
    expect((await pool.query('SELECT 1 FROM admin_recovery_code WHERE admin_user_id = $1', [OWNER])).rowCount).toBe(0);
  });
});

describe.skipIf(!isTestDb)('P1b: required TOTP (store setting) gives an enrolment-only session', () => {
  async function requireForStore() {
    await pool.query(`UPDATE store SET config = jsonb_set(coalesce(config, '{}'::jsonb), '{security}', '{"requireTotp": true}'::jsonb) WHERE id = $1`, [STORE]);
  }

  it('an owner without TOTP signs in, but can only enrol until they do', async () => {
    await requireForStore();
    const { res, body } = await login('owner@mfa.test', PW);
    expect(res.status).toBe(200);
    expect(body.totpEnrollmentRequired).toBe(true);
    const token = body.token!;
    const blocked = await req('GET', '/v1/admin/orders', { token });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('TOTP_ENROLLMENT_REQUIRED');
    expect((await req('POST', '/v1/admin/staff/invites', { token, body: { email: 'x@mfa.test', role: 'staff' } })).status).toBe(403);
    const me = (await (await req('GET', '/v1/admin/me', { token })).json()) as { totpEnrollmentRequired: boolean };
    expect(me.totpEnrollmentRequired).toBe(true);
    await enrol(token);
    expect((await req('GET', '/v1/admin/orders', { token })).status).toBe(200);
  });

  it('the store setting covers owners and managers, not ordinary staff', async () => {
    await requireForStore();
    expect((await login('manager@mfa.test', PW)).body.totpEnrollmentRequired).toBe(true);
    const staff = await login('staff@mfa.test', PW);
    expect(staff.body.totpEnrollmentRequired).toBeUndefined();
    expect((await req('GET', '/v1/admin/orders', { token: staff.body.token })).status).toBe(200);
  });

  it('only an owner with a recent step-up can turn the requirement on', async () => {
    const manager = (await login('manager@mfa.test', PW)).body.token!;
    expect((await req('PATCH', '/v1/admin/settings/security', { token: manager, body: { requireTotp: true } })).status).toBe(403);
    const owner = (await login('owner@mfa.test', PW)).body.token!;
    const noStepUp = await req('PATCH', '/v1/admin/settings/security', { token: owner, body: { requireTotp: true } });
    expect(noStepUp.status).toBe(403);
    expect(((await noStepUp.json()) as { error: { message: string } }).error.message).toBe('step_up_required');
    expect((await req('POST', '/v1/admin/step-up', { token: owner, body: { password: PW } })).status).toBe(200);
    const on = await req('PATCH', '/v1/admin/settings/security', { token: owner, body: { requireTotp: true } });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ requireTotp: true });
    const cfg = (await pool.query('SELECT config FROM store WHERE id = $1', [STORE])).rows[0].config as { security?: { requireTotp?: boolean } };
    expect(cfg.security?.requireTotp).toBe(true);
    // the owner has no TOTP yet, so from now on their own session can only enrol
    expect((await req('GET', '/v1/admin/settings/security', { token: owner })).status).toBe(403);
  });
});

describe.skipIf(!isTestDb)('P1b: authenticated password change', () => {
  it('needs a recent step-up and the current password; signs out every other session; the new password works', async () => {
    const a = (await login('owner@mfa.test', PW)).body.token!;
    const b = (await login('owner@mfa.test', PW)).body.token!;
    const NEW = 'a-new-long-password-2';
    expect((await req('POST', '/v1/admin/password', { token: a, body: { currentPassword: PW, newPassword: NEW } })).status).toBe(403);
    expect((await req('POST', '/v1/admin/step-up', { token: a, body: { password: PW } })).status).toBe(200);
    expect((await req('POST', '/v1/admin/password', { token: a, body: { currentPassword: 'wrong', newPassword: NEW } })).status).toBe(401);
    const ok = await req('POST', '/v1/admin/password', { token: a, body: { currentPassword: PW, newPassword: NEW } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { revokedSessions: number }).revokedSessions).toBe(1);
    expect((await req('GET', '/v1/admin/me', { token: a })).status).toBe(200);
    expect((await req('GET', '/v1/admin/me', { token: b })).status).toBe(401);
    expect((await login('owner@mfa.test', PW)).res.status).toBe(401);
    expect((await login('owner@mfa.test', NEW)).res.status).toBe(200);
  });
});

describe.skipIf(!isTestDb)('TOTP replay guard is durable and atomic (security audit 2026-10-15)', () => {
  async function withTotp() {
    const secret = newTotpSecret();
    await pool.query('UPDATE admin_user SET totp_secret = $1 WHERE id = $2', [secret, OWNER]);
    return secret;
  }

  it('two concurrent sign-ins with the SAME code: exactly one succeeds', async () => {
    const secret = await withTotp();
    const code = totpAt(secret, step());
    const [a, b] = await Promise.all([login('owner@mfa.test', PW, code), login('owner@mfa.test', PW, code)]);
    expect([a.res.status, b.res.status].sort()).toEqual([200, 401]);
  });

  it('a used code stays used across processes (state is in the database, not process memory)', async () => {
    const secret = await withTotp();
    const code = totpAt(secret, step());
    expect((await login('owner@mfa.test', PW, code)).res.status).toBe(200);
    const recorded = await pool.query('SELECT step FROM admin_totp_used_step WHERE admin_user_id = $1', [OWNER]);
    expect(recorded.rows.map((r) => Number(r.step))).toEqual([step()]);
    expect((await login('owner@mfa.test', PW, code)).res.status).toBe(401);
  });

  it('an OLDER code (previous step, still inside the drift window) is refused once a newer one was used', async () => {
    const secret = await withTotp();
    expect((await login('owner@mfa.test', PW, totpAt(secret, step()))).res.status).toBe(200);
    expect((await login('owner@mfa.test', PW, totpAt(secret, step() - 1))).res.status).toBe(401);
    expect((await login('owner@mfa.test', PW, totpAt(secret, step() + 1))).res.status).toBe(200);
  });
});

describe.skipIf(!isTestDb)('admin password rehash on sign-in', () => {
  it('a legacy scrypt admin hash (e.g. RightSites) is upgraded to Argon2id after a successful sign-in', async () => {
    const { scryptSync, randomBytes } = await import('node:crypto');
    const salt = randomBytes(16);
    const legacy = `scrypt$${salt.toString('hex')}$${scryptSync(PW, salt, 64).toString('hex')}`;
    await pool.query('UPDATE admin_user SET password_hash = $1 WHERE id = $2', [legacy, OWNER]);
    expect((await login('owner@mfa.test', PW)).res.status).toBe(200);
    const after = (await pool.query('SELECT password_hash FROM admin_user WHERE id = $1', [OWNER])).rows[0].password_hash as string;
    expect(after.startsWith('$argon2id$')).toBe(true);
    expect((await login('owner@mfa.test', PW)).res.status).toBe(200);
  });
});


describe.skipIf(!isTestDb)('P1b review: session assurance and credential races', () => {
  it('enrolling through one session signs out the admin\'s other (password-only) sessions', async () => {
    const a = (await login('owner@mfa.test', PW)).body.token!;
    const b = (await login('owner@mfa.test', PW)).body.token!;
    await enrol(a);
    expect((await req('GET', '/v1/admin/me', { token: a })).status).toBe(200);
    expect((await req('GET', '/v1/admin/me', { token: b })).status).toBe(401);
  });

  it('a session is only created for the credential that was verified; a rehash never overwrites a newer password', async () => {
    const { createAdminSessionIfCredential, rehashAdminPasswordIfUnchanged } = await import('./auth/admin-session.js');
    const old = (await pool.query('SELECT password_hash FROM admin_user WHERE id = $1', [OWNER])).rows[0].password_hash as string;
    const replaced = await hashPassword('replaced-password-1');
    await pool.query('UPDATE admin_user SET password_hash = $1 WHERE id = $2', [replaced, OWNER]); // a password change landed meanwhile
    expect(await createAdminSessionIfCredential(OWNER, old, false)).toBeNull();
    expect(await rehashAdminPasswordIfUnchanged(OWNER, old, await hashPassword(PW))).toBe(false);
    expect((await pool.query('SELECT password_hash FROM admin_user WHERE id = $1', [OWNER])).rows[0].password_hash).toBe(replaced);
    expect(await createAdminSessionIfCredential(OWNER, replaced, false)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('concurrent recovery-code regenerations leave exactly one valid set', async () => {
    const { regenerateRecoveryCodes } = await import('./auth/second-factor.js');
    const [x, y] = await Promise.all([regenerateRecoveryCodes(OWNER), regenerateRecoveryCodes(OWNER)]);
    const stored = (await pool.query('SELECT count(*)::int AS n FROM admin_recovery_code WHERE admin_user_id = $1', [OWNER])).rows[0].n as number;
    expect(stored).toBe(10);
    expect(x).not.toEqual(y);
  });
});

describe.skipIf(!isTestDb)('P1b final review: enrolment and password-change races', () => {
  it('a password-only sign-in cannot complete after 2FA was enabled meanwhile', async () => {
    const { createAdminSessionIfCredential } = await import('./auth/admin-session.js');
    const hash = (await pool.query('SELECT password_hash FROM admin_user WHERE id = $1', [OWNER])).rows[0].password_hash as string;
    await pool.query('UPDATE admin_user SET totp_secret = $1 WHERE id = $2', [newTotpSecret(), OWNER]);
    expect(await createAdminSessionIfCredential(OWNER, hash, false)).toBeNull();
    expect(await createAdminSessionIfCredential(OWNER, hash, true)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a second, stale password change cannot overwrite the first', async () => {
    const { changeAdminPassword } = await import('./auth/admin-session.js');
    const a = (await login('owner@mfa.test', PW)).body.token!;
    const b = (await login('owner@mfa.test', PW)).body.token!;
    const old = (await pool.query('SELECT password_hash FROM admin_user WHERE id = $1', [OWNER])).rows[0].password_hash as string;
    expect(await changeAdminPassword(OWNER, old, await hashPassword('first-new-password'), a)).toBe(1); // revokes b
    expect(await changeAdminPassword(OWNER, old, await hashPassword('second-new-password'), b)).toBeNull();
    expect((await login('owner@mfa.test', 'first-new-password')).res.status).toBe(200);
  });
});

