/**
 * #355 phase 2: the saved-account hub end to end through the real app and a disposable database. The same app plays
 * both servers: the hub (HUB_*) and the target (ADMIN_HANDOFF_*), with the hub's outbound calls routed to app.request.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import { _resetPoolsForTest, initPools } from '../db/client.js';
import { env } from '../env.js';
import { hashPassword } from '../auth/password.js';
import { proxyPathAllowed, setHubFetchForTests } from '../auth/hub.js';
import { buildHttpApp } from '../app.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
requireDisposablePostgresUrl(DB, 'hub.db.test.ts');
const owner = new Pool({ connectionString: DB });
_resetPoolsForTest(); initPools({ ...env, DATABASE_URL: env.DATABASE_URL_NONOWNER ?? DB });
const app = buildHttpApp();

const STORE = 'c3550000-0000-4000-8000-000000000002';
const PASSWORD = 'correct horse battery staple 355b';
const SECRET = 'hub-client-secret-355b-' + 'x'.repeat(20);
const HUB = 'https://hub.example.test';
const TARGET = 'https://target.example.test';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

let ipSeq = Math.floor(Math.random() * 16_000_000);
const freshIp = () => { const n = ++ipSeq; return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`; };
const req = (path: string, init: RequestInit = {}) => app.request(path, init, { remoteAddr: freshIp() });
const errCode = async (r: Response) => ((await r.clone().json()) as { error?: { code?: string } }).error?.code;

let hash = '';
let outboundCalls: string[] = [];

interface Browser { cookie: string; csrf: string }
async function hubBrowser(): Promise<Browser> {
  const r = await req('/v1/hub/session', { method: 'POST', headers: { origin: HUB } });
  expect(r.status).toBe(200);
  const jar = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  expect(jar).toMatch(/sr_hub=/);
  return { cookie: jar, csrf: ((await r.json()) as { csrf: string }).csrf };
}
const hubCall = (b: Browser, path: string, init: RequestInit = {}, over: Record<string, string> = {}) =>
  req(path, { ...init, headers: { cookie: b.cookie, origin: HUB, 'x-hub-csrf': b.csrf, 'content-type': 'application/json', ...over, ...(init.headers as Record<string, string> ?? {}) } });

async function makeAdmin() {
  const id = randomUUID(), email = `h-${id.slice(0, 8)}@hub355.test`;
  await owner.query('INSERT INTO admin_user(id,email,password_hash,kind) VALUES($1,$2,$3,$4)', [id, email, hash, 'human']);
  await owner.query('INSERT INTO admin_user_store(admin_user_id,store_id,role) VALUES($1,$2,$3)', [id, STORE, 'manager']);
  return { id, email };
}
async function signIn(email: string): Promise<string> {
  const r = await req('/v1/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD, returnToken: true }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

/** The full ceremony: hub enrol -> target sign-in + authorize -> hub callback. Returns the callback's redirect. */
async function enrol(b: Browser, email: string): Promise<URL> {
  const e = await hubCall(b, '/v1/hub/enrol', { method: 'POST', body: JSON.stringify({ targetId: 'shop' }) });
  expect(e.status).toBe(200);
  const page = new URL(((await e.json()) as { redirectTo: string }).redirectTo);
  expect(page.origin + page.pathname).toBe(`${TARGET}/admin/handoff`);
  const p = page.searchParams;
  const token = await signIn(email);
  const a = await req('/v1/admin/handoff/authorize', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ clientId: p.get('client_id'), redirectUri: p.get('redirect_uri'), state: p.get('state'), codeChallenge: p.get('code_challenge'), codeChallengeMethod: p.get('code_challenge_method') }) });
  expect(a.status).toBe(200);
  const cb = new URL(((await a.json()) as { redirectTo: string }).redirectTo);
  expect(cb.origin).toBe(HUB);
  const done = await req(cb.pathname + cb.search, { headers: { cookie: b.cookie } });
  expect(done.status).toBe(302);
  const back = new URL(done.headers.get('location')!);
  back.hash = cb.pathname + cb.search; // keep the callback for replay tests
  return back;
}

async function wipe() {
  await owner.query('DELETE FROM hub_session');
  const ids = (await owner.query('SELECT id FROM admin_user WHERE email LIKE $1', ['%@hub355.test'])).rows.map((r) => r.id as string);
  await owner.query("SELECT set_config('app.current_store', $1, false)", [STORE]);
  await owner.query('DELETE FROM admin_preference WHERE store_id=$1', [STORE]);
  await owner.query('DELETE FROM admin_handoff_code WHERE admin_user_id = ANY($1::uuid[])', [ids]);
  await owner.query('DELETE FROM admin_auth_challenge WHERE admin_user_id = ANY($1::uuid[])', [ids]);
  for (const t of ['"session"', 'admin_user_store']) await owner.query(`DELETE FROM ${t} WHERE admin_user_id = ANY($1::uuid[])`, [ids]);
  await owner.query('DELETE FROM admin_user WHERE id = ANY($1::uuid[])', [ids]);
  await owner.query("SELECT set_config('app.current_store', $1, false)", [STORE]);
  await owner.query('DELETE FROM audit_log WHERE store_id=$1', [STORE]);
  await owner.query('DELETE FROM store WHERE id=$1', [STORE]);
}
const enableHub = () => {
  env.HUB_ORIGIN = HUB;
  env.HUB_TARGETS = JSON.stringify([{ id: 'shop', label: 'Shop', origin: TARGET, clientId: 'hub', clientSecret: SECRET }]);
  env.HUB_VAULT_KEYS = `1:${randomBytes(32).toString('base64')}`;
};
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
  setHubFetchForTests(async (input, init) => {
    const u = new URL(String(input));
    outboundCalls.push(`${init?.method ?? 'GET'} ${u.origin}${u.pathname}`);
    expect(u.origin).toBe(TARGET);
    return req(u.pathname + u.search, init as RequestInit);
  });
});
beforeEach(async () => {
  env.ADMIN_HANDOFF_ISSUER = TARGET;
  env.ADMIN_HANDOFF_CLIENTS = JSON.stringify([{ id: 'hub', redirectUri: `${HUB}/v1/hub/callback/shop`, secretSha256: sha(SECRET) }]);
  enableHub();
  outboundCalls = [];
  await wipe();
  await owner.query("INSERT INTO store(id,slug,name,currency,config) VALUES($1,'hub-355','Hub Store','USD','{}')", [STORE]);
});
afterAll(async () => {
  setHubFetchForTests(null);
  for (const k of ['ADMIN_HANDOFF_ISSUER', 'ADMIN_HANDOFF_CLIENTS', 'HUB_ORIGIN', 'HUB_TARGETS', 'HUB_VAULT_KEYS'] as const) env[k] = undefined;
  await wipe(); await owner.end();
});

describe('hub enrolment and relay', () => {
  it('enrols an account, keeps its bearer sealed, relays admin calls and lists it', async () => {
    const a = await makeAdmin();
    const b = await hubBrowser();
    const back = await enrol(b, a.email);
    expect(back.origin + back.pathname).toBe(`${HUB}/admin/accounts`);
    const slotId = back.searchParams.get('enrolled');
    expect(slotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(outboundCalls).toContain(`POST ${TARGET}/v1/admin/handoff/token`);

    const [slot] = (await owner.query('SELECT admin_id, admin_email, token_sealed FROM hub_account_slot WHERE id=$1', [slotId])).rows;
    expect(slot.admin_id).toBe(a.id);
    expect(Object.keys(slot.token_sealed).sort()).toEqual(['ct', 'iv', 'tag', 'v']);
    expect((await owner.query("SELECT 1 FROM session WHERE admin_user_id=$1 AND handoff_client_id='hub'", [a.id])).rowCount).toBe(1);

    const list = await hubCall(b, '/v1/hub/accounts');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { accounts: Array<{ id: string; adminEmail: string; targetLabel: string }> };
    expect(body.accounts).toEqual([expect.objectContaining({ id: slotId, adminEmail: a.email, targetLabel: 'Shop' })]);

    const me = await hubCall(b, `/v1/hub/accounts/${slotId}/admin/me`);
    expect(me.status).toBe(200);
    expect(me.headers.get('set-cookie')).toBeNull();
    expect(me.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await me.json())).toContain(a.email);

    // A write relays the body, the store selection and the saved account's identity; it needs the hub CSRF.
    const put = (csrf: string) => hubCall(b, `/v1/hub/accounts/${slotId}/admin/preferences/hub-test`,
      { method: 'PUT', body: JSON.stringify({ value: { n: 1 } }) }, { 'x-store-slug': 'hub-355', 'x-hub-csrf': csrf });
    expect(await errCode(await put('0'.repeat(32)))).toBe('CSRF_INVALID');
    const saved = await put(b.csrf);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ key: 'hub-test', value: { n: 1 } });
    expect((await owner.query("SELECT store_id, value FROM admin_preference WHERE admin_user_id=$1 AND key='hub-test'", [a.id])).rows).toEqual([{ store_id: STORE, value: { n: 1 } }]);
  });

  it('spends the enrolment once and refuses a callback from another browser', async () => {
    const a = await makeAdmin();
    const b = await hubBrowser();
    const back = await enrol(b, a.email);
    const replay = await req(back.hash.slice(1), { headers: { cookie: b.cookie } });
    expect(new URL(replay.headers.get('location')!).searchParams.get('error')).toBe('unknown_state');
    const other = await hubBrowser();
    const stolen = await req(back.hash.slice(1), { headers: { cookie: other.cookie } });
    expect(new URL(stolen.headers.get('location')!).searchParams.get('error')).toBe('unknown_state');
  });

  it('refuses mutations without CSRF or from another origin, and denied or odd relay paths', async () => {
    const a = await makeAdmin();
    const b = await hubBrowser();
    const slotId = (await enrol(b, a.email)).searchParams.get('enrolled')!;
    expect(await errCode(await hubCall(b, '/v1/hub/enrol', { method: 'POST', body: '{"targetId":"shop"}' }, { 'x-hub-csrf': 'f'.repeat(32) }))).toBe('CSRF_INVALID');
    expect(await errCode(await hubCall(b, '/v1/hub/enrol', { method: 'POST', body: '{"targetId":"shop"}' }, { origin: 'https://evil.example' }))).toBe('HUB_ORIGIN_REFUSED');
    expect(await errCode(await req('/v1/hub/session', { method: 'POST' }))).toBe('HUB_ORIGIN_REFUSED');
    expect(await errCode(await hubCall(b, `/v1/hub/accounts/${slotId}/admin/logout`, { method: 'POST' }))).toBe('HUB_PATH_REFUSED');
    expect(await errCode(await hubCall(b, `/v1/hub/accounts/${slotId}/admin/orders/a%2fb`))).toBe('HUB_PATH_REFUSED');
    expect(await errCode(await hubCall(b, `/v1/hub/accounts/${randomUUID()}/admin/me`))).toBe('HUB_SLOT_NOT_FOUND');
    const other = await hubBrowser();
    expect(await errCode(await hubCall(other, `/v1/hub/accounts/${slotId}/admin/me`))).toBe('HUB_SLOT_NOT_FOUND');
    for (const ok of ['me', 'orders', 'orders/123/refunds']) expect(proxyPathAllowed(ok)).toBe(true);
    for (const bad of ['', '/me', 'me/', 'a//b', '..', 'orders/../me', 'handoff/token', 'Login', 'passkeys/x', 'staff/accept', 'a%2fb']) expect(proxyPathAllowed(bad)).toBe(false);
  });

  it('removing an account signs its session out on the target; a dead target session asks for a new sign-in', async () => {
    const a = await makeAdmin();
    const b = await hubBrowser();
    const slotId = (await enrol(b, a.email)).searchParams.get('enrolled')!;
    expect((await hubCall(b, `/v1/hub/accounts/${slotId}`, { method: 'DELETE' })).status).toBe(200);
    expect(outboundCalls).toContain(`POST ${TARGET}/v1/admin/logout`);
    expect((await owner.query("SELECT 1 FROM session WHERE admin_user_id=$1 AND handoff_client_id='hub'", [a.id])).rowCount).toBe(0);

    const again = (await enrol(b, a.email)).searchParams.get('enrolled')!;
    await owner.query("DELETE FROM session WHERE admin_user_id=$1 AND handoff_client_id='hub'", [a.id]);
    expect(await errCode(await hubCall(b, `/v1/hub/accounts/${again}/admin/me`))).toBe('HUB_SLOT_REAUTH');
    expect((await owner.query('SELECT 1 FROM hub_account_slot WHERE id=$1', [again])).rowCount).toBe(0);
  });

  it('sign-out revokes every saved account and ends the hub session', async () => {
    const a = await makeAdmin();
    const b = await hubBrowser();
    await enrol(b, a.email);
    const out = await hubCall(b, '/v1/hub/signout', { method: 'POST' });
    expect(out.status).toBe(200);
    expect((await owner.query('SELECT 1 FROM hub_session')).rowCount).toBe(0);
    expect(await errCode(await hubCall(b, '/v1/hub/accounts'))).toBe('HUB_NO_SESSION');
  });

  it('is off unless all three HUB_* settings are present', async () => {
    env.HUB_VAULT_KEYS = undefined;
    expect(await errCode(await req('/v1/hub/session', { method: 'POST', headers: { origin: HUB } }))).toBe('FEATURE_DISABLED');
  });
});
