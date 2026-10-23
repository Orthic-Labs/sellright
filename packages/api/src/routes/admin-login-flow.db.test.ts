/**
 * Issue #333: the admin sign-in journey end to end through the real app (buildHttpApp) and a disposable database.
 *   - step 1 (email + password) signs a no-2FA account straight in; an account with a second factor gets a short-lived,
 *     single-use, server-side challenge token and NO session;
 *   - step 2 redeems the token once with a TOTP or recovery code; expiry, attempt cap, credential change and replay kill it;
 *   - both steps are rate-limited on the shared admin budgets; unknown e-mail and wrong password answer the same 401;
 *   - a passkey satisfies the 2FA requirement; enrolment right after sign-in needs only the code, and the pending
 *     secret rotates on every setup call;
 *   - forgot / reset password; store branding for the sign-in screens.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import { _resetPoolsForTest, initPools } from '../db/client.js';
import { env } from '../env.js';
import { hashPassword } from '../auth/password.js';
import { sealTotpSecret } from '../auth/totp-secret.js';
import { issuePasswordReset, LOGIN_CHALLENGE_MAX_ATTEMPTS } from '../auth/admin-auth-challenge.js';
import { regenerateRecoveryCodes } from '../auth/second-factor.js';
import { buildHttpApp } from '../app.js';
import { invalidateStoreCache } from '../store-context.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
requireDisposablePostgresUrl(DB, 'admin-login-flow.db.test.ts');
const owner = new Pool({ connectionString: DB });
_resetPoolsForTest(); initPools({ ...env, DATABASE_URL: env.DATABASE_URL_NONOWNER ?? DB });
const app = buildHttpApp();

const STORE = 'c3330000-0000-4000-8000-000000000001';
const SLUG = 'login-flow-333';
const PASSWORD = 'correct horse battery staple 333';
const SECRET = 'JBSWY3DPEHPK3PXP';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

function totp(secretB32: string, stepOffset = 0): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32.toUpperCase().replace(/=+$/, '')) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + stepOffset));
  const h = createHmac('sha1', Buffer.from(bytes)).update(buf).digest(), o = h[h.length - 1]! & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

// Rate-limit buckets live in the database for 15 minutes: start each run at a random point of 10.0.0.0/8 so re-runs
// never inherit a spent budget.
let ipSeq = Math.floor(Math.random() * 16_000_000);
/** Every case gets its own client address (a public peer: pickClientIp uses the socket address). */
const freshIp = () => { const n = ++ipSeq; return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`; };
const post = (path: string, body: unknown, ip: string, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, { remoteAddr: ip });
const get = (path: string, headers: Record<string, string> = {}, ip = freshIp()) => app.request(path, { headers }, { remoteAddr: ip });
const sessionCookie = (r: Response) => /(?:^|[, ]+)sr_admin=([^;, ]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1];
const errCode = async (r: Response) => ((await r.clone().json()) as { error?: { code?: string } }).error?.code;

let hash = '';
async function makeAdmin(opts: { totp?: boolean; role?: string; passkey?: boolean } = {}) {
  const id = randomUUID(), email = `a-${id.slice(0, 8)}@login333.test`;
  await owner.query('INSERT INTO admin_user(id,email,password_hash,totp_secret) VALUES($1,$2,$3,$4)', [id, email, hash, opts.totp ? sealTotpSecret(id, SECRET) : null]);
  await owner.query('INSERT INTO admin_user_store(admin_user_id,store_id,role) VALUES($1,$2,$3)', [id, STORE, opts.role ?? 'staff']);
  if (opts.passkey) {
    await owner.query(`INSERT INTO admin_passkey_credential(admin_user_id,rp_id,credential_id,public_key,device_type,backed_up,label,epoch)
      VALUES($1,'localhost',$2,'\\x00'::bytea,'multiDevice',true,'Test key',0)`, [id, `cred-${id}`]);
  }
  return { id, email };
}
const sessions = async (id: string) => (await owner.query('SELECT step_up_at, step_up_epoch FROM "session" WHERE admin_user_id=$1', [id])).rows;
const challenges = async (id: string) => (await owner.query('SELECT token_hash, kind, attempts, consumed_at FROM admin_auth_challenge WHERE admin_user_id=$1', [id])).rows;

async function wipe() {
  const ids = (await owner.query('SELECT id FROM admin_user WHERE email LIKE $1', ['%@login333.test'])).rows.map((r) => r.id as string);
  for (const t of ['"session"', 'admin_user_store', 'admin_recovery_code', 'admin_totp_used_step']) await owner.query(`DELETE FROM ${t} WHERE admin_user_id = ANY($1::uuid[])`, [ids]);
  await owner.query('DELETE FROM admin_user WHERE id = ANY($1::uuid[])', [ids]);
  await owner.query("SELECT set_config('app.current_store', $1, false)", [STORE]);
  await owner.query('DELETE FROM audit_log WHERE store_id=$1', [STORE]);
  await owner.query('DELETE FROM store WHERE id=$1', [STORE]);
}
beforeAll(async () => { hash = await hashPassword(PASSWORD); });
beforeEach(async () => {
  await wipe();
  await owner.query("INSERT INTO store(id,slug,name,currency,config) VALUES($1,$2,'Login Flow Store','USD','{}')", [STORE, SLUG]);
});
afterAll(async () => { await wipe(); await owner.end(); });

describe('step 1: email + password', () => {
  it('signs an account without 2FA straight in (session cookie, no challenge, no step-up)', async () => {
    const a = await makeAdmin();
    const r = await post('/v1/admin/login', { email: a.email, password: PASSWORD }, freshIp());
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body.twoFactorRequired).toBeUndefined();
    expect(body.challengeToken).toBeUndefined();
    expect(sessionCookie(r)).toBeTruthy();
    const [s] = await sessions(a.id);
    expect(s?.step_up_at).toBeNull(); // a sign-in is not a step-up
    expect(await challenges(a.id)).toEqual([]);
  });

  it('answers an unknown e-mail and a wrong password with the same generic 401 and issues nothing', async () => {
    const a = await makeAdmin({ totp: true });
    const unknown = await post('/v1/admin/login', { email: 'nobody@login333.test', password: PASSWORD }, freshIp());
    const wrong = await post('/v1/admin/login', { email: a.email, password: 'not the password' }, freshIp());
    expect(unknown.status).toBe(401); expect(wrong.status).toBe(401);
    expect((await unknown.json() as { error: unknown }).error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'invalid email or password' });
    expect((await wrong.json() as { error: unknown }).error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'invalid email or password' });
    expect(await challenges(a.id)).toEqual([]);
    expect(await sessions(a.id)).toEqual([]);
  });

  it('for a 2FA account returns a challenge only after the right password — never a session', async () => {
    const a = await makeAdmin({ totp: true });
    const r = await post('/v1/admin/login', { email: a.email, password: PASSWORD }, freshIp());
    expect(r.status).toBe(200);
    const body = await r.json() as { twoFactorRequired: boolean; challengeToken: string; methods: string[]; expiresInSeconds: number };
    expect(body).toMatchObject({ twoFactorRequired: true, methods: ['totp', 'recovery_code'], expiresInSeconds: 300 });
    expect(body.challengeToken.length).toBeGreaterThanOrEqual(40);
    expect(sessionCookie(r)).toBeUndefined();
    expect(await sessions(a.id)).toEqual([]);
    const rows = await challenges(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'login_2fa', token_hash: sha(body.challengeToken), attempts: 0 }); // only the hash is stored
  });

  it('keeps the single-request form (password + code together) for API clients', async () => {
    const a = await makeAdmin({ totp: true });
    const r = await post('/v1/admin/login', { email: a.email, password: PASSWORD, totp: totp(SECRET), returnToken: true }, freshIp());
    expect(r.status).toBe(200);
    expect(((await r.json()) as { token?: string }).token).toBeTruthy();
    const bad = await post('/v1/admin/login', { email: a.email, password: PASSWORD, totp: '000000' }, freshIp());
    expect(bad.status).toBe(401);
    expect((await bad.json() as { error: { message: string } }).error.message).toBe('invalid email, password, or 2FA code');
  });
});

describe('step 2: the challenge token', () => {
  async function stepOne(email: string, ip = freshIp()) {
    const r = await post('/v1/admin/login', { email, password: PASSWORD }, ip);
    expect(r.status).toBe(200);
    return ((await r.json()) as { challengeToken: string }).challengeToken;
  }

  it('signs in with the code once; a replay of the same token is refused', async () => {
    const a = await makeAdmin({ totp: true });
    const ip = freshIp(), token = await stepOne(a.email, ip);
    const wrong = await post('/v1/admin/login/2fa', { challengeToken: token, code: '000000' }, ip);
    expect(wrong.status).toBe(401); expect(await errCode(wrong)).toBe('INVALID_CODE');
    const ok = await post('/v1/admin/login/2fa', { challengeToken: token, code: totp(SECRET) }, ip);
    expect(ok.status).toBe(200);
    expect(sessionCookie(ok)).toBeTruthy();
    expect(await sessions(a.id)).toHaveLength(1);
    const replay = await post('/v1/admin/login/2fa', { challengeToken: token, code: totp(SECRET, 1) }, ip);
    expect(replay.status).toBe(401); expect(await errCode(replay)).toBe('LOGIN_CHALLENGE_EXPIRED');
    expect(await sessions(a.id)).toHaveLength(1);
  });

  it('accepts a one-time recovery code at step 2 (and only once)', async () => {
    const a = await makeAdmin({ totp: true });
    const [code] = await regenerateRecoveryCodes(a.id);
    const ok = await post('/v1/admin/login/2fa', { challengeToken: await stepOne(a.email), code: code! }, freshIp());
    expect(ok.status).toBe(200);
    const again = await post('/v1/admin/login/2fa', { challengeToken: await stepOne(a.email), code: code! }, freshIp());
    expect(again.status).toBe(401);
  });

  it('expires: a token past its expiry is refused even with the right code', async () => {
    const a = await makeAdmin({ totp: true });
    const token = await stepOne(a.email);
    await owner.query("UPDATE admin_auth_challenge SET expires_at = now() - interval '1 second' WHERE token_hash=$1", [sha(token)]);
    const r = await post('/v1/admin/login/2fa', { challengeToken: token, code: totp(SECRET) }, freshIp());
    expect(r.status).toBe(401); expect(await errCode(r)).toBe('LOGIN_CHALLENGE_EXPIRED');
    expect(await sessions(a.id)).toEqual([]);
  });

  it(`dies after ${LOGIN_CHALLENGE_MAX_ATTEMPTS} wrong codes, even for a later right one`, async () => {
    const a = await makeAdmin({ totp: true });
    const token = await stepOne(a.email);
    for (let i = 0; i < LOGIN_CHALLENGE_MAX_ATTEMPTS; i++) expect((await post('/v1/admin/login/2fa', { challengeToken: token, code: '000000' }, freshIp())).status).toBe(401);
    const r = await post('/v1/admin/login/2fa', { challengeToken: token, code: totp(SECRET) }, freshIp());
    expect(r.status).toBe(401); expect(await errCode(r)).toBe('LOGIN_CHALLENGE_EXHAUSTED');
  });

  it('two concurrent redemptions of one challenge with the right code create exactly one session', async () => {
    const a = await makeAdmin({ totp: true });
    const [code] = await regenerateRecoveryCodes(a.id);
    const token = await stepOne(a.email);
    const ip = freshIp();
    // the same valid factor sent twice at once (a recovery code: single use on its own, so this isolates the claim)
    const rs = await Promise.all([post('/v1/admin/login/2fa', { challengeToken: token, code: code! }, ip), post('/v1/admin/login/2fa', { challengeToken: token, code: code! }, ip)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await sessions(a.id)).toHaveLength(1);
    // and with two different valid codes: still one winner
    const [c1, c2] = await regenerateRecoveryCodes(a.id);
    const t2 = await stepOne(a.email);
    const rs2 = await Promise.all([post('/v1/admin/login/2fa', { challengeToken: t2, code: c1! }, ip), post('/v1/admin/login/2fa', { challengeToken: t2, code: c2! }, ip)]);
    expect(rs2.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await sessions(a.id)).toHaveLength(2);
  });

  it('dies when the 2FA setup changes between the steps (epoch bump: TOTP enabled after step 1)', async () => {
    const a = await makeAdmin({ passkey: true });
    const [code] = await regenerateRecoveryCodes(a.id);
    const token = await stepOne(a.email);
    await owner.query('UPDATE admin_user SET totp_secret=$2 WHERE id=$1', [a.id, sealTotpSecret(a.id, SECRET)]); // trigger bumps the epoch
    const r = await post('/v1/admin/login/2fa', { challengeToken: token, code: code! }, freshIp());
    expect(r.status).toBe(401); expect(await errCode(r)).toBe('LOGIN_CHALLENGE_EXPIRED');
    expect(await sessions(a.id)).toEqual([]);
  });

  it('dies when the password changes after step 1, and a newer step 1 replaces an older token', async () => {
    const a = await makeAdmin({ totp: true });
    const first = await stepOne(a.email), second = await stepOne(a.email);
    expect((await post('/v1/admin/login/2fa', { challengeToken: first, code: totp(SECRET) }, freshIp())).status).toBe(401);
    await owner.query('UPDATE admin_user SET password_hash=$2 WHERE id=$1', [a.id, await hashPassword('another password 333')]);
    const r = await post('/v1/admin/login/2fa', { challengeToken: second, code: totp(SECRET) }, freshIp());
    expect(r.status).toBe(401); expect(await errCode(r)).toBe('LOGIN_CHALLENGE_EXPIRED');
    expect(await sessions(a.id)).toEqual([]);
  });

  it('refuses an unknown token generically', async () => {
    const r = await post('/v1/admin/login/2fa', { challengeToken: 'x'.repeat(43), code: '123456' }, freshIp());
    expect(r.status).toBe(401); expect(await errCode(r)).toBe('LOGIN_CHALLENGE_EXPIRED');
  });
});

describe('rate limits', () => {
  it('step 1: the (ip, account) budget answers 429 with retry-after', async () => {
    const a = await makeAdmin();
    const ip = freshIp();
    for (let i = 0; i < 8; i++) expect((await post('/v1/admin/login', { email: a.email, password: 'wrong' }, ip)).status).toBe(401);
    const r = await post('/v1/admin/login', { email: a.email, password: PASSWORD }, ip);
    expect(r.status).toBe(429);
    const body = await r.json() as { error: { code: string; message: string }; retryAfterSeconds: number };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(r.headers.get('retry-after')).toBe(String(body.retryAfterSeconds));
    expect(body.error.message).toMatch(/try again in \d+s/);
  });

  it('step 2 spends the same account budget as step 1', async () => {
    const a = await makeAdmin({ totp: true });
    const ip = freshIp();
    let token = await stepOne(a.email, ip); // 1
    for (let i = 0; i < 5; i++) await post('/v1/admin/login/2fa', { challengeToken: token, code: '000000' }, ip); // 6
    token = await stepOne(a.email, ip); // 7
    expect((await post('/v1/admin/login/2fa', { challengeToken: token, code: '000000' }, ip)).status).toBe(401); // 8
    const r = await post('/v1/admin/login/2fa', { challengeToken: token, code: totp(SECRET) }, ip);
    expect(r.status).toBe(429);
  });

  async function stepOne(email: string, ip: string) {
    const r = await post('/v1/admin/login', { email, password: PASSWORD }, ip);
    return ((await r.json()) as { challengeToken: string }).challengeToken;
  }
});

describe('passkeys as the second factor', () => {
  it('a passkey-only account gets the code step (passkey or recovery code), never a session from the password alone', async () => {
    const a = await makeAdmin({ passkey: true });
    const r = await post('/v1/admin/login', { email: a.email, password: PASSWORD }, freshIp());
    const body = await r.json() as { twoFactorRequired?: boolean; methods?: string[] };
    expect(body).toMatchObject({ twoFactorRequired: true, methods: ['passkey', 'recovery_code'] });
    expect(sessionCookie(r)).toBeUndefined();
    // No authenticator app: a 6-digit code is never a factor for this account.
    const single = await post('/v1/admin/login', { email: a.email, password: PASSWORD, totp: '123456' }, freshIp());
    expect(single.status).toBe(401);
  });

  it('a registered passkey satisfies the 2FA requirement on its own', async () => {
    const a = await makeAdmin({ role: 'owner', passkey: true });
    await owner.query("UPDATE store SET config='{\"security\":{\"requireTotp\":true}}' WHERE id=$1", [STORE]);
    const [code] = await regenerateRecoveryCodes(a.id);
    const t = ((await (await post('/v1/admin/login', { email: a.email, password: PASSWORD }, freshIp())).json()) as { challengeToken: string }).challengeToken;
    const r = await post('/v1/admin/login/2fa', { challengeToken: t, code: code! }, freshIp());
    expect(r.status).toBe(200);
    expect(((await r.clone().json()) as { totpEnrollmentRequired?: boolean }).totpEnrollmentRequired).toBeUndefined();
    const me = await get('/v1/admin/me', { cookie: `sr_admin=${sessionCookie(r)}`, 'x-store-slug': SLUG });
    expect(await me.json()).toMatchObject({ totpEnrollmentRequired: false, passkeyEnabled: true, totpEnabled: false });
  });
});

describe('mandatory enrolment right after sign-in', () => {
  async function enrolSession() {
    const a = await makeAdmin({ role: 'owner' });
    await owner.query("UPDATE store SET config='{\"security\":{\"requireTotp\":true}}' WHERE id=$1", [STORE]);
    const r = await post('/v1/admin/login', { email: a.email, password: PASSWORD }, freshIp());
    expect(((await r.clone().json()) as { totpEnrollmentRequired?: boolean }).totpEnrollmentRequired).toBe(true);
    const token = sessionCookie(r)!;
    const csrf = /sr_csrf=([^;, ]+)/.exec(r.headers.get('set-cookie') ?? '')![1]!;
    const h = { cookie: `sr_admin=${token}; sr_csrf=${csrf}`, 'x-csrf-token': csrf, 'x-store-slug': SLUG };
    return { a, h };
  }

  it('setup returns a QR (SVG, store as issuer) and a NEW secret on every call; only the latest one confirms; no password needed', async () => {
    const { a, h } = await enrolSession();
    const s1 = await (await post('/v1/admin/2fa/setup', {}, freshIp(), h)).json() as { secret: string; qrSvg: string; otpauthUri: string; passwordRequired: boolean; issuer: string };
    const s2 = await (await post('/v1/admin/2fa/setup', {}, freshIp(), h)).json() as typeof s1;
    expect(s1.secret).not.toBe(s2.secret);
    expect(s2.qrSvg.startsWith('<svg')).toBe(true);
    expect(s2.issuer).toBe('Login Flow Store');
    expect(s2.otpauthUri).toContain(`otpauth://totp/Login%20Flow%20Store:${encodeURIComponent(a.email)}?secret=${s2.secret}&issuer=Login%20Flow%20Store`);
    expect(s2.passwordRequired).toBe(false);
    const rows = await challenges(a.id);
    expect(rows.filter((r) => r.kind === 'totp_enroll' && !r.consumed_at)).toHaveLength(1); // the old pending secret is gone
    const stale = await post('/v1/admin/2fa/enable', { code: totp(s1.secret) }, freshIp(), h);
    expect(stale.status).toBe(409);
    // naming the superseded QR is refused outright (the screen then fetches a new one)
    const staleId = await post('/v1/admin/2fa/enable', { code: totp(s2.secret), setupId: (s1 as unknown as { setupId: string }).setupId }, freshIp(), h);
    expect(staleId.status).toBe(409); expect(await errCode(staleId)).toBe('SETUP_EXPIRED');
    const ok = await post('/v1/admin/2fa/enable', { code: totp(s2.secret), setupId: (s2 as unknown as { setupId: string }).setupId }, freshIp(), h);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
  });

  it('an older session must re-enter the password', async () => {
    const { a, h } = await enrolSession();
    await owner.query("UPDATE \"session\" SET created_at = now() - interval '1 hour' WHERE admin_user_id=$1", [a.id]);
    const s = await (await post('/v1/admin/2fa/setup', {}, freshIp(), h)).json() as { secret: string; passwordRequired: boolean };
    expect(s.passwordRequired).toBe(true);
    const r = await post('/v1/admin/2fa/enable', { code: totp(s.secret) }, freshIp(), h);
    expect(r.status).toBe(401); expect(await errCode(r)).toBe('PASSWORD_REQUIRED');
    expect((await post('/v1/admin/2fa/enable', { code: totp(s.secret), password: PASSWORD }, freshIp(), h)).status).toBe(200);
  });
});

describe('forgot / reset password', () => {
  it('answers every address the same; a reset link works once, signs out everywhere and keeps 2FA', async () => {
    const a = await makeAdmin({ totp: true });
    for (const email of [a.email, 'nobody@login333.test']) {
      const r = await post('/v1/admin/password/forgot', { email }, freshIp());
      expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true });
    }
    await post('/v1/admin/login', { email: a.email, password: PASSWORD, totp: totp(SECRET) }, freshIp());
    expect(await sessions(a.id)).toHaveLength(1);
    const token = await issuePasswordReset(a.id, hash, 0);
    const next = 'a brand new password 333';
    expect((await post('/v1/admin/password/reset', { token, password: next }, freshIp())).status).toBe(200);
    expect(await sessions(a.id)).toEqual([]);
    const again = await post('/v1/admin/password/reset', { token, password: 'yet another password' }, freshIp());
    expect(again.status).toBe(400); expect(await errCode(again)).toBe('RESET_INVALID');
    const login = await post('/v1/admin/login', { email: a.email, password: next }, freshIp());
    expect(((await login.json()) as { twoFactorRequired?: boolean }).twoFactorRequired).toBe(true);
  });

  it('a reset link dies when the password changed after it was issued', async () => {
    const a = await makeAdmin();
    const token = await issuePasswordReset(a.id, hash, 0);
    await owner.query('UPDATE admin_user SET password_hash=$2 WHERE id=$1', [a.id, await hashPassword('changed elsewhere 333')]);
    const r = await post('/v1/admin/password/reset', { token, password: 'a brand new password 333' }, freshIp());
    expect(r.status).toBe(400);
  });
});

describe('sign-in branding', () => {
  it('serves the store name, logo and validated theme tokens for the resolved store; neutral when unpublished or malformed', async () => {
    const setConfig = async (config: unknown) => { await owner.query('UPDATE store SET config=$2::jsonb WHERE id=$1', [STORE, JSON.stringify(config)]); invalidateStoreCache(); };
    const identity = { storeName: 'Damned Designs', logoImageUrl: '/logo.svg', colors: { primary: '#B87333', background: '#F7F2EA', surface: '#FFFFFF', text: '#111110', textMuted: '#5C5A55', border: '#E4DED3' },
      fonts: { display: "'Cormorant Garamond', serif", body: "'IBM Plex Sans', sans-serif" }, fontFaces: [{ family: 'Cormorant Garamond', url: '/fonts/cormorant.woff2', weight: '600' }, { family: 'x', url: 'https://evil.example/x.woff2' }] };
    await setConfig({ identity });
    const r = await get('/v1/admin/branding', { 'x-store-slug': SLUG });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ storeName: 'Damned Designs', logoUrl: '/logo.svg',
      theme: { primary: '#B87333', background: '#F7F2EA', surface: '#FFFFFF', text: '#111110', textMuted: '#5C5A55', border: '#E4DED3', fontDisplay: "'Cormorant Garamond', serif", fontBody: "'IBM Plex Sans', sans-serif", fontLogo: null },
      fontFaces: [{ family: 'Cormorant Garamond', url: '/fonts/cormorant.woff2', weight: '600', style: 'normal' }] });
    await setConfig({ identity: { ...identity, colors: { ...identity.colors, primary: 'red;background:url(x)' } } });
    expect(((await (await get('/v1/admin/branding', { 'x-store-slug': SLUG })).json()) as { theme: unknown }).theme).toBeNull();
    await setConfig({ identity, published: false });
    expect(await (await get('/v1/admin/branding', { 'x-store-slug': SLUG })).json()).toEqual({ storeName: null, logoUrl: null, theme: null, fontFaces: [] });
    expect(await (await get('/v1/admin/branding', { 'x-store-slug': 'no-such-store-333' })).json()).toEqual({ storeName: null, logoUrl: null, theme: null, fontFaces: [] });
  });
});

// ── #333 review additions ──────────────────────────────────────────────────────
async function sessionFor(adminId: string, opts: { stepUp?: boolean; createdAgoMinutes?: number } = {}) {
  const token = randomUUID() + randomUUID();
  const [{ epoch }] = (await owner.query('SELECT security_epoch AS epoch FROM admin_user WHERE id=$1', [adminId])).rows;
  await owner.query(`INSERT INTO "session"(admin_user_id,token_hash,expires_at,created_at,last_seen_at,step_up_at,step_up_epoch)
    VALUES($1,$2,now()+interval '1 day',now()-make_interval(mins => $3),now(),$4,$5)`,
  [adminId, sha(token), opts.createdAgoMinutes ?? 0, opts.stepUp ? new Date() : null, opts.stepUp ? epoch : null]);
  return { authorization: `Bearer ${token}`, 'x-store-slug': SLUG };
}
const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { remoteAddr: freshIp() });
const requireTotp = () => owner.query("UPDATE store SET config='{\"security\":{\"requireTotp\":true}}' WHERE id=$1", [STORE]).then(() => invalidateStoreCache());

describe('passkey management (#333 review)', () => {
  it('DELETE /passkeys/:id refuses the last factor of a 2FA-required account (409 LAST_SECOND_FACTOR)', async () => {
    const a = await makeAdmin({ role: 'owner', passkey: true });
    await requireTotp();
    const h = await sessionFor(a.id, { stepUp: true });
    const [{ id }] = (await owner.query('SELECT id FROM admin_passkey_credential WHERE admin_user_id=$1', [a.id])).rows;
    const r = await call('DELETE', `/v1/admin/passkeys/${id}`, h);
    expect(r.status).toBe(409); expect(await errCode(r)).toBe('LAST_SECOND_FACTOR');
    expect((await owner.query('SELECT id FROM admin_passkey_credential WHERE admin_user_id=$1', [a.id])).rows).toHaveLength(1);
  });

  it('an old session (no step-up, signed in long ago) cannot register a passkey: 403 step_up_required', async () => {
    const a = await makeAdmin();
    const r = await call('POST', '/v1/admin/passkeys/register/options', await sessionFor(a.id, { createdAgoMinutes: 60 }), {});
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { message: string } }).error.message).toBe('step_up_required');
    expect((await call('POST', '/v1/admin/passkeys/register/options', await sessionFor(a.id), {})).status).toBe(200); // a fresh one may
  });

  it('a passkey-only account regenerates recovery codes with password + a recovery code, or password + a fresh passkey step-up — never the password alone', async () => {
    const a = await makeAdmin({ passkey: true });
    const [code] = await regenerateRecoveryCodes(a.id);
    const plain = await sessionFor(a.id);
    const bare = await call('POST', '/v1/admin/2fa/recovery-codes', plain, { password: PASSWORD });
    expect(bare.status).toBe(403);
    const sixDigits = await call('POST', '/v1/admin/2fa/recovery-codes', plain, { password: PASSWORD, code: '123456' });
    expect(sixDigits.status).toBe(409);
    const withCode = await call('POST', '/v1/admin/2fa/recovery-codes', plain, { password: PASSWORD, code: code! });
    expect(withCode.status).toBe(200);
    expect(((await withCode.json()) as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
    const stepped = await call('POST', '/v1/admin/2fa/recovery-codes', await sessionFor(a.id, { stepUp: true }), { password: PASSWORD });
    expect(stepped.status).toBe(200);
    const wrongPw = await call('POST', '/v1/admin/2fa/recovery-codes', await sessionFor(a.id, { stepUp: true }), { password: 'nope nope nope' });
    expect(wrongPw.status).toBe(401);
  });

  it('TOTP can be disabled while a passkey remains (even when 2FA is required); the passkey and recovery codes stay valid', async () => {
    const a = await makeAdmin({ role: 'owner', totp: true, passkey: true });
    await requireTotp();
    await regenerateRecoveryCodes(a.id);
    const r = await call('POST', '/v1/admin/2fa/disable', await sessionFor(a.id), { password: PASSWORD, code: totp(SECRET) });
    expect(r.status).toBe(200);
    const row = (await owner.query('SELECT u.totp_secret, u.security_epoch AS epoch, p.epoch AS pk FROM admin_user u JOIN admin_passkey_credential p ON p.admin_user_id=u.id WHERE u.id=$1', [a.id])).rows[0];
    expect(row.totp_secret).toBeNull();
    expect(row.pk).toBe(row.epoch); // re-stamped across the bump
    expect((await owner.query('SELECT count(*)::int AS n FROM admin_recovery_code WHERE admin_user_id=$1', [a.id])).rows[0].n).toBe(10);
    // without the passkey the requirement refuses removing the last factor
    const b = await makeAdmin({ role: 'owner', totp: true });
    const refused = await call('POST', '/v1/admin/2fa/disable', await sessionFor(b.id), { password: PASSWORD, code: totp(SECRET) });
    expect(refused.status).toBe(403); expect(await errCode(refused)).toBe('TOTP_REQUIRED');
  });
});

describe('forgot / reset (#333 review)', () => {
  it('forgot: identical answers for known and unknown addresses; the per-address budget answers 429 with Retry-After', async () => {
    const a = await makeAdmin();
    const bodies: string[] = [];
    for (const email of [a.email, 'nobody-333@login333.test']) {
      const r = await post('/v1/admin/password/forgot', { email }, freshIp());
      expect(r.status).toBe(200); bodies.push(await r.text());
    }
    expect(bodies[0]).toBe(bodies[1]);
    for (let i = 0; i < 2; i++) expect((await post('/v1/admin/password/forgot', { email: a.email }, freshIp())).status).toBe(200);
    const limited = await post('/v1/admin/password/forgot', { email: a.email }, freshIp());
    expect(limited.status).toBe(429);
    const body = await limited.json() as { error: { code: string }; retryAfterSeconds: number };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.headers.get('retry-after')).toBe(String(body.retryAfterSeconds));
  });

  it('check + reset: a live link checks valid; an expired one checks invalid and cannot reset; a used one cannot be reused', async () => {
    const a = await makeAdmin();
    const token = await issuePasswordReset(a.id, hash, 0);
    expect(await (await post('/v1/admin/password/reset/check', { token }, freshIp())).json()).toEqual({ valid: true });
    await owner.query("UPDATE admin_auth_challenge SET expires_at = now() - interval '1 second' WHERE token_hash=$1", [sha(token)]);
    expect(await (await post('/v1/admin/password/reset/check', { token }, freshIp())).json()).toEqual({ valid: false });
    const expired = await post('/v1/admin/password/reset', { token, password: 'a brand new password 333' }, freshIp());
    expect(expired.status).toBe(400); expect(await errCode(expired)).toBe('RESET_INVALID');
    const t2 = await issuePasswordReset(a.id, hash, 0);
    expect((await post('/v1/admin/password/reset', { token: t2, password: 'a brand new password 333' }, freshIp())).status).toBe(200);
    expect(await (await post('/v1/admin/password/reset/check', { token: t2 }, freshIp())).json()).toEqual({ valid: false });
    expect((await post('/v1/admin/password/reset', { token: t2, password: 'another new password 333' }, freshIp())).status).toBe(400);
    const short = await post('/v1/admin/password/reset', { token: await issuePasswordReset(a.id, (await owner.query('SELECT password_hash FROM admin_user WHERE id=$1', [a.id])).rows[0].password_hash, 0), password: 'short' }, freshIp());
    expect(short.status).toBe(400); // one shared 10-character minimum
  });

  it('a reset bumps the epoch, signs out every session and puts passkeys under review: a passkey session can do nothing else, and only the NEW password completes the review', async () => {
    const a = await makeAdmin({ passkey: true });
    await owner.query(`INSERT INTO admin_passkey_credential(admin_user_id,rp_id,credential_id,public_key,device_type,backed_up,label,epoch)
      VALUES($1,'localhost',$2,'\\x00'::bytea,'singleDevice',false,'Intruder key',0)`, [a.id, `cred2-${a.id}`]);
    const before = (await owner.query('SELECT security_epoch FROM admin_user WHERE id=$1', [a.id])).rows[0].security_epoch;
    await sessionFor(a.id);
    const next = 'a brand new password 333';
    expect((await post('/v1/admin/password/reset', { token: await issuePasswordReset(a.id, hash, before), password: next }, freshIp())).status).toBe(200);
    const after = (await owner.query('SELECT security_epoch, passkey_review_required FROM admin_user WHERE id=$1', [a.id])).rows[0];
    expect(after.security_epoch).toBe(before + 1);
    expect(after.passkey_review_required).toBe(true);
    expect(await sessions(a.id)).toEqual([]);
    expect((await owner.query('SELECT DISTINCT epoch FROM admin_passkey_credential WHERE admin_user_id=$1', [a.id])).rows).toEqual([{ epoch: before + 1 }]);

    const h = await sessionFor(a.id); // e.g. a passkey sign-in
    expect(await (await call('GET', '/v1/admin/me', h)).json()).toMatchObject({ passkeyReviewRequired: true });
    const blocked = await call('GET', '/v1/admin/orders', h);
    expect(blocked.status).toBe(403); expect(await errCode(blocked)).toBe('PASSKEY_REVIEW_REQUIRED');
    const [legit, intruder] = (await owner.query('SELECT id, label FROM admin_passkey_credential WHERE admin_user_id=$1 ORDER BY label DESC', [a.id])).rows as { id: string; label: string }[];
    expect(legit!.label).toBe('Test key'); expect(intruder!.label).toBe('Intruder key');
    expect((await call('POST', '/v1/admin/passkeys/review', h, { password: PASSWORD, keep: [legit!.id] })).status).toBe(401); // the OLD password
    const ok = await call('POST', '/v1/admin/passkeys/review', h, { password: next, keep: [legit!.id] });
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ ok: true, removed: 1 });
    expect((await owner.query('SELECT label FROM admin_passkey_credential WHERE admin_user_id=$1', [a.id])).rows).toEqual([{ label: 'Test key' }]);
    expect((await call('GET', '/v1/admin/orders', h)).status).not.toBe(403);
  });
});
