/**
 * #355 phase 1: the target side of the saved-account hub handoff through the real app (buildHttpApp) and a disposable
 * database. A code is issued only to a fresh human session for an exactly registered client + callback, redeems once,
 * server to server, with the client secret and the PKCE verifier, and yields a new session for the same admin.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import { _resetPoolsForTest, initPools } from '../db/client.js';
import { env } from '../env.js';
import { hashPassword } from '../auth/password.js';
import { s256 } from '../auth/admin-handoff.js';
import { buildHttpApp } from '../app.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
requireDisposablePostgresUrl(DB, 'admin-handoff.db.test.ts');
const owner = new Pool({ connectionString: DB });
_resetPoolsForTest(); initPools({ ...env, DATABASE_URL: env.DATABASE_URL_NONOWNER ?? DB });
const app = buildHttpApp();

const STORE = 'c3550000-0000-4000-8000-000000000001';
const SLUG = 'handoff-355';
const PASSWORD = 'correct horse battery staple 355';
const SECRET = 'hub-client-secret-355-' + 'x'.repeat(20);
const CALLBACK = 'https://hub.example.test/v1/hub/callback';
const ISSUER = 'https://target.example.test';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

let ipSeq = Math.floor(Math.random() * 16_000_000);
const freshIp = () => { const n = ++ipSeq; return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`; };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, { remoteAddr: freshIp() });
const errCode = async (r: Response) => ((await r.clone().json()) as { error?: { code?: string } }).error?.code;

let hash = '';
async function makeAdmin(kind: 'human' | 'agent' = 'human') {
  const id = randomUUID(), email = `h-${id.slice(0, 8)}@handoff355.test`;
  await owner.query('INSERT INTO admin_user(id,email,password_hash,kind) VALUES($1,$2,$3,$4)', [id, email, kind === 'human' ? hash : null, kind]);
  await owner.query('INSERT INTO admin_user_store(admin_user_id,store_id,role) VALUES($1,$2,$3)', [id, STORE, 'manager']);
  return { id, email };
}
async function signIn(email: string): Promise<string> {
  const r = await post('/v1/admin/login', { email, password: PASSWORD, returnToken: true });
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}
const pkce = () => { const verifier = randomBytes(48).toString('base64url'); return { verifier, challenge: s256(verifier) }; };
const authorize = (token: string, over: Record<string, unknown> = {}, challenge = pkce().challenge) =>
  post('/v1/admin/handoff/authorize', { clientId: 'hub', redirectUri: CALLBACK, state: 'state-' + randomBytes(12).toString('hex'), codeChallenge: challenge, codeChallengeMethod: 'S256', ...over },
    { authorization: `Bearer ${token}` });
const codeFrom = async (r: Response) => {
  expect(r.status).toBe(200);
  const to = new URL(((await r.json()) as { redirectTo: string }).redirectTo);
  expect(to.origin + to.pathname).toBe(CALLBACK);
  expect(to.searchParams.get('iss')).toBe(ISSUER);
  return to.searchParams.get('code')!;
};
const redeem = (code: string, verifier: string, over: Record<string, unknown> = {}) =>
  post('/v1/admin/handoff/token', { grantType: 'authorization_code', clientId: 'hub', clientSecret: SECRET, redirectUri: CALLBACK, code, codeVerifier: verifier, ...over });

async function wipe() {
  const ids = (await owner.query('SELECT id FROM admin_user WHERE email LIKE $1', ['%@handoff355.test'])).rows.map((r) => r.id as string);
  await owner.query('DELETE FROM admin_handoff_code WHERE admin_user_id = ANY($1::uuid[])', [ids]);
  await owner.query('DELETE FROM admin_auth_challenge WHERE admin_user_id = ANY($1::uuid[])', [ids]);
  for (const t of ['"session"', 'admin_user_store']) await owner.query(`DELETE FROM ${t} WHERE admin_user_id = ANY($1::uuid[])`, [ids]);
  await owner.query('DELETE FROM admin_user WHERE id = ANY($1::uuid[])', [ids]);
  await owner.query("SELECT set_config('app.current_store', $1, false)", [STORE]);
  await owner.query('DELETE FROM audit_log WHERE store_id=$1', [STORE]);
  await owner.query('DELETE FROM store WHERE id=$1', [STORE]);
}
beforeAll(async () => { hash = await hashPassword(PASSWORD); });
beforeEach(async () => {
  env.ADMIN_HANDOFF_ISSUER = ISSUER;
  env.ADMIN_HANDOFF_CLIENTS = JSON.stringify([{ id: 'hub', redirectUri: CALLBACK, secretSha256: sha(SECRET) }]);
  await wipe();
  await owner.query("INSERT INTO store(id,slug,name,currency,config) VALUES($1,$2,'Handoff Store','USD','{}')", [STORE, SLUG]);
});
afterAll(async () => { env.ADMIN_HANDOFF_ISSUER = undefined; env.ADMIN_HANDOFF_CLIENTS = undefined; await wipe(); await owner.end(); });

describe('handoff happy path', () => {
  it('issues a hashed one-use code and redeems it once for a new session of the same admin', async () => {
    const a = await makeAdmin();
    const token = await signIn(a.email);
    const { verifier, challenge } = pkce();
    const code = await codeFrom(await authorize(token, {}, challenge));
    const rows = (await owner.query('SELECT code_hash, client_id, redirect_uri FROM admin_handoff_code WHERE admin_user_id=$1', [a.id])).rows;
    expect(rows).toEqual([{ code_hash: sha(code), client_id: 'hub', redirect_uri: CALLBACK }]); // only the hash is stored

    const r = await redeem(code, verifier);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as { token: string; tokenType: string; admin: { id: string; email: string }; issuer: string };
    expect(body).toMatchObject({ tokenType: 'Bearer', admin: { id: a.id, email: a.email }, issuer: ISSUER });
    expect(body.token).not.toBe(token);

    const me = await app.request('/v1/admin/me', { headers: { authorization: `Bearer ${body.token}` } }, { remoteAddr: freshIp() });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string; stores: { slug: string }[] })).toMatchObject({ email: a.email, stores: [{ slug: SLUG }] });

    expect((await redeem(code, verifier)).status).toBe(400); // replay
    expect((await owner.query('SELECT 1 FROM admin_handoff_code WHERE admin_user_id=$1', [a.id])).rowCount).toBe(0);
  });
  it('the minted session is marked as the hub\'s and never counts as a fresh sign-in', async () => {
    const a = await makeAdmin();
    const { verifier, challenge } = pkce();
    const code = await codeFrom(await authorize(await signIn(a.email), {}, challenge));
    const hub = ((await (await redeem(code, verifier)).json()) as { token: string }).token;
    expect((await owner.query('SELECT handoff_client_id FROM "session" WHERE token_hash=$1', [sha(hub)])).rows).toEqual([{ handoff_client_id: 'hub' }]);
    // A hub session cannot mint another handoff (it would extend itself forever without the person)...
    const again = await authorize(hub);
    expect(again.status).toBe(403);
    expect(await errCode(again)).toBe('STEP_UP_REQUIRED');
    // ...nor enrol a first second factor without the password, while a real fresh sign-in may (issue #333).
    const hubSetup = await post('/v1/admin/2fa/setup', {}, { authorization: `Bearer ${hub}`, 'x-store-slug': SLUG });
    expect(hubSetup.status).toBe(200);
    expect(((await hubSetup.json()) as { passwordRequired: boolean }).passwordRequired).toBe(true);
    const enable = await post('/v1/admin/2fa/enable', { code: '123456' }, { authorization: `Bearer ${hub}`, 'x-store-slug': SLUG });
    expect(enable.status).toBe(401);
    expect(await errCode(enable)).toBe('PASSWORD_REQUIRED');
    const ownSetup = await post('/v1/admin/2fa/setup', {}, { authorization: `Bearer ${await signIn(a.email)}`, 'x-store-slug': SLUG });
    expect(((await ownSetup.json()) as { passwordRequired: boolean }).passwordRequired).toBe(false);
  });
});

describe('authorize refusals', () => {
  it('refuses an unregistered client or a callback that is not byte-equal, and stores nothing', async () => {
    const a = await makeAdmin();
    const token = await signIn(a.email);
    expect(await errCode(await authorize(token, { clientId: 'other' }))).toBe('HANDOFF_UNKNOWN_CLIENT');
    expect(await errCode(await authorize(token, { redirectUri: CALLBACK + '/' }))).toBe('HANDOFF_UNKNOWN_CLIENT');
    expect(await errCode(await authorize(token, { redirectUri: 'https://evil.example.test/v1/hub/callback' }))).toBe('HANDOFF_UNKNOWN_CLIENT');
    expect(await errCode(await authorize(token, { codeChallenge: 'short' }))).toBe('HANDOFF_BAD_REQUEST');
    expect((await owner.query('SELECT 1 FROM admin_handoff_code WHERE admin_user_id=$1', [a.id])).rowCount).toBe(0);
  });

  it('needs a session signed in (or stepped up) in the last 10 minutes', async () => {
    const a = await makeAdmin();
    const token = await signIn(a.email);
    await owner.query("UPDATE \"session\" SET created_at = now() - interval '11 minutes' WHERE admin_user_id=$1", [a.id]);
    const r = await authorize(token);
    expect(r.status).toBe(403);
    expect(await errCode(r)).toBe('STEP_UP_REQUIRED');
  });

  it('is off (404) without an issuer or a registered client, and needs a session', async () => {
    const a = await makeAdmin();
    const token = await signIn(a.email);
    env.ADMIN_HANDOFF_CLIENTS = undefined;
    expect((await authorize(token)).status).toBe(404);
    env.ADMIN_HANDOFF_CLIENTS = JSON.stringify([{ id: 'hub', redirectUri: CALLBACK, secretSha256: sha(SECRET) }]);
    expect((await post('/v1/admin/handoff/authorize', { clientId: 'hub', redirectUri: CALLBACK, state: 'state-0123456789abcdef', codeChallenge: pkce().challenge, codeChallengeMethod: 'S256' })).status).toBe(401);
  });
});

describe('redeem refusals', () => {
  it('a wrong verifier spends the code', async () => {
    const a = await makeAdmin();
    const { verifier, challenge } = pkce();
    const code = await codeFrom(await authorize(await signIn(a.email), {}, challenge));
    expect(await errCode(await redeem(code, pkce().verifier))).toBe('INVALID_GRANT');
    expect(await errCode(await redeem(code, verifier))).toBe('INVALID_GRANT');
  });

  it('a wrong client secret is invalid_client and does NOT spend the code', async () => {
    const a = await makeAdmin();
    const { verifier, challenge } = pkce();
    const code = await codeFrom(await authorize(await signIn(a.email), {}, challenge));
    const bad = await redeem(code, verifier, { clientSecret: 'nope' });
    expect(bad.status).toBe(401);
    expect(await errCode(bad)).toBe('INVALID_CLIENT');
    expect((await redeem(code, verifier)).status).toBe(200);
  });

  it('wrong secrets for the public client id never lock out the real hub (no per-client budget)', async () => {
    const a = await makeAdmin();
    for (let i = 0; i < 25; i++) expect((await redeem('x'.repeat(43), 'y'.repeat(43), { clientSecret: 'guess-' + i })).status).toBe(401);
    const { verifier, challenge } = pkce();
    const code = await codeFrom(await authorize(await signIn(a.email), {}, challenge));
    expect((await redeem(code, verifier)).status).toBe(200);
  });

  it('an expired code is refused', async () => {
    const a = await makeAdmin();
    const { verifier, challenge } = pkce();
    const code = await codeFrom(await authorize(await signIn(a.email), {}, challenge));
    await owner.query("UPDATE admin_handoff_code SET expires_at = now() - interval '1 second' WHERE code_hash=$1", [sha(code)]);
    expect(await errCode(await redeem(code, verifier))).toBe('INVALID_GRANT');
  });

  it('signing out the issuing session or a security change before redemption kills the code', async () => {
    const a = await makeAdmin();
    const t1 = await signIn(a.email);
    const p1 = pkce();
    const c1 = await codeFrom(await authorize(t1, {}, p1.challenge));
    expect((await post('/v1/admin/logout', {}, { authorization: `Bearer ${t1}` })).status).toBe(200);
    expect(await errCode(await redeem(c1, p1.verifier))).toBe('INVALID_GRANT');

    const t2 = await signIn(a.email);
    const p2 = pkce();
    const c2 = await codeFrom(await authorize(t2, {}, p2.challenge));
    await owner.query('UPDATE admin_user SET security_epoch = security_epoch + 1 WHERE id=$1', [a.id]);
    expect(await errCode(await redeem(c2, p2.verifier))).toBe('INVALID_GRANT');
  });
});
