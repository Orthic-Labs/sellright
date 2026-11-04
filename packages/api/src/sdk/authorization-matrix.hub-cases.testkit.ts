/** #355 phase 2: the saved-account hub (broker side). Its own browser session, Origin and CSRF are the credential: every
 *  admin principal's headers ride along and grant nothing. Source-only, never packed into engine. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../env.js';
import { setHubFetchForTests } from '../auth/hub.js';
import type { MatrixIdentityFixture } from './authorization-matrix.identity-cases.testkit.js';
import { PRINCIPALS, type MatrixCase, type MatrixPrincipal, type MatrixProof, type PreparedMatrixCell } from './authorization-matrix.testkit.js';

const HUB = 'https://hub.matrix.invalid', TARGET = 'https://target.matrix.invalid', TID = 'matrix-target', CLIENT = 'matrix-hub2';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Browser = { cookie: string; csrf: string; sessionId: string; headers(principal: MatrixPrincipal, mutation?: boolean): Record<string, string> };

export function createHubCases(fixture: MatrixIdentityFixture): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const secret = 'matrix-hub2-secret-' + randomBytes(16).toString('hex'), vaultKey = `1:${randomBytes(32).toString('base64')}`;
  let peerId = 0;
  const peer = () => ({ remoteAddr: '198.51.100.' + (++peerId % 250 + 1) });
  const global = async (sql: string, values: unknown[] = []) => (await fixture.queryGlobal(sql, values)).rows;
  const on = () => {
    env.ADMIN_HANDOFF_ISSUER = TARGET;
    env.ADMIN_HANDOFF_CLIENTS = JSON.stringify([{ id: CLIENT, redirectUri: `${HUB}/v1/hub/callback/${TID}`, secretSha256: digest(secret) }]);
    env.HUB_ORIGIN = HUB;
    env.HUB_TARGETS = JSON.stringify([{ id: TID, label: 'Matrix target', origin: TARGET, clientId: CLIENT, clientSecret: secret }]);
    env.HUB_VAULT_KEYS = vaultKey;
    // The hub's server-to-server calls stay in process; any other destination is a fixture failure.
    setHubFetchForTests(async (input, init) => {
      const u = new URL(String(input));
      if (u.origin !== TARGET) throw new Error('hub matrix: unexpected destination');
      return fixture.request(u.pathname + u.search, init as RequestInit, peer());
    });
  };
  const browser = async (): Promise<Browser> => {
    const r = await fixture.request('/v1/hub/session', { method: 'POST', headers: { origin: HUB } }, peer());
    assert.equal(r.status, 200, 'hub session prerequisite');
    const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const token = /(?:^|; )sr_hub=([^;]+)/.exec(cookie)?.[1];
    assert.ok(token, 'hub session cookie');
    const [row] = await global('SELECT id FROM hub_session WHERE token_hash=$1', [digest(token!)]);
    const csrf = ((await r.json()) as { csrf: string }).csrf;
    return { cookie, csrf, sessionId: row!.id as string, headers: (principal, mutation = true) => ({ ...fixture.requestHeaders[principal], cookie,
      ...(mutation ? { origin: HUB, 'x-hub-csrf': csrf } : {}), 'content-type': 'application/json' }) };
  };
  /** Runs enrolment up to the target's redirect; returns the callback a browser would follow. */
  const authorized = async (b: Browser) => {
    const e = await fixture.request('/v1/hub/enrol', { method: 'POST', headers: b.headers('owner'), body: JSON.stringify({ targetId: TID }) }, peer());
    assert.equal(e.status, 200, 'enrol prerequisite');
    const p = new URL(((await e.json()) as { redirectTo: string }).redirectTo).searchParams;
    const admin = await fixture.freshIdentity('staff');
    const a = await fixture.request('/v1/admin/handoff/authorize', { method: 'POST',
      headers: { authorization: 'Bearer ' + admin.token, 'x-store-slug': fixture.storeSlug, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: p.get('client_id'), redirectUri: p.get('redirect_uri'), state: p.get('state'), codeChallenge: p.get('code_challenge'), codeChallengeMethod: 'S256' }) }, peer());
    assert.equal(a.status, 200, 'target authorize prerequisite');
    const cb = new URL(((await a.json()) as { redirectTo: string }).redirectTo);
    return { admin, callback: cb.pathname + cb.search };
  };
  const enrolled = async (b: Browser) => {
    const { admin, callback } = await authorized(b);
    const r = await fixture.request(callback, { headers: { cookie: b.cookie } }, peer());
    const slotId = new URL(r.headers.get('location') ?? `${HUB}/`).searchParams.get('enrolled');
    assert.ok(slotId, 'callback prerequisite saved the account');
    return { admin, slotId: slotId! };
  };
  const add = (key: string, status: number, prepare: (principal: MatrixPrincipal) => Promise<PreparedMatrixCell>, errorCode?: string) => {
    const allow = status < 400;
    cases.push({ key, contract: 'public', cells: Object.fromEntries(PRINCIPALS.map((principal) => [principal, {
      effect: allow ? 'allow' : 'deny', status, ...(errorCode ? { errorCode } : {}),
      async prepare() { on(); return prepare(principal); },
    }])) as MatrixCase['cells'] });
  };
  const method = (key: string) => key.slice(0, key.indexOf(' '));

  add('POST /v1/hub/session', 200, async (principal) => {
    const [{ n: before }] = await global('SELECT count(*)::int AS n FROM hub_session') as [{ n: number }];
    return { url: '/v1/hub/session', env: peer(), init: { method: 'POST', headers: { ...fixture.requestHeaders[principal], origin: HUB } }, async verify(response: Response, proof: MatrixProof) {
      const body = await response.json() as { csrf: string; targets: unknown };
      proof.ok(/^[0-9a-f]{32}$/.test(body.csrf), 'a CSRF token for this browser');
      proof.equal(body.targets, [{ id: TID, label: 'Matrix target' }], 'configured servers only');
      proof.equal(await global('SELECT count(*)::int AS n FROM hub_session'), [{ n: before + 1 }], 'one new hub session; admin headers select nothing', 'state');
    } };
  });
  add('GET /v1/hub/accounts', 200, async (principal) => {
    const b = await browser();
    return { url: '/v1/hub/accounts', env: peer(), init: { method: 'GET', headers: b.headers(principal, false) }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await response.json(), { targets: [{ id: TID, label: 'Matrix target' }], accounts: [] }, 'a new browser has no saved accounts, whoever else it is signed in as');
    } };
  });
  add('POST /v1/hub/enrol', 200, async (principal) => {
    const b = await browser();
    return { url: '/v1/hub/enrol', env: peer(), init: { method: 'POST', headers: b.headers(principal), body: JSON.stringify({ targetId: TID }) }, async verify(response: Response, proof: MatrixProof) {
      const to = new URL(((await response.json()) as { redirectTo: string }).redirectTo);
      proof.equal(to.origin + to.pathname, `${TARGET}/admin/handoff`, 'only the configured target');
      proof.equal(await global('SELECT target_id FROM hub_enrolment WHERE hub_session_id=$1', [b.sessionId]), [{ target_id: TID }], 'one pending enrolment for this browser', 'state');
    } };
  });
  add('GET /v1/hub/callback/{targetId}', 302, async (principal) => {
    const b = await browser();
    const { admin, callback } = await authorized(b);
    return { url: callback, env: peer(), init: { method: 'GET', headers: b.headers(principal, false) }, async verify(response: Response, proof: MatrixProof) {
      const back = new URL(response.headers.get('location') ?? `${HUB}/`);
      proof.equal(back.origin + back.pathname, `${HUB}/admin/accounts`, 'back to the hub only');
      proof.equal(await global('SELECT id::text AS id, admin_id FROM hub_account_slot WHERE hub_session_id=$1', [b.sessionId]),
        [{ id: back.searchParams.get('enrolled'), admin_id: admin.id }], 'the account that signed in on the target is saved in this browser', 'state');
      proof.equal(await global('SELECT 1 FROM hub_enrolment WHERE hub_session_id=$1', [b.sessionId]), [], 'enrolment spent', 'state');
    } };
  });
  add('DELETE /v1/hub/accounts/{slotId}', 200, async (principal) => {
    const b = await browser();
    const { admin, slotId } = await enrolled(b);
    return { url: `/v1/hub/accounts/${slotId}`, env: peer(), init: { method: 'DELETE', headers: b.headers(principal) }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await response.json(), { ok: true }, 'exact success response');
      proof.equal(await global('SELECT 1 FROM hub_account_slot WHERE id=$1', [slotId]), [], 'saved account forgotten', 'state');
      proof.equal(await global('SELECT 1 FROM session WHERE admin_user_id=$1 AND handoff_client_id=$2', [admin.id, CLIENT]), [], 'its session signed out on the target', 'state');
    } };
  });
  add('POST /v1/hub/signout', 200, async (principal) => {
    const b = await browser();
    return { url: '/v1/hub/signout', env: peer(), init: { method: 'POST', headers: b.headers(principal) }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await response.json(), { ok: true }, 'exact success response');
      proof.equal(await global('SELECT 1 FROM hub_session WHERE id=$1', [b.sessionId]), [], 'hub session ended', 'state');
    } };
  });
  add('GET /v1/hub/accounts/{slotId}/admin/*', 200, async (principal) => {
    const b = await browser();
    const { admin, slotId } = await enrolled(b);
    return { url: `/v1/hub/accounts/${slotId}/admin/me`, env: peer(), init: { method: 'GET', headers: b.headers(principal, false) }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(response.headers.get('cache-control'), 'no-store', 'relayed answers are never cached');
      proof.ok(JSON.stringify(await response.json()).includes(admin.email), 'the saved account answers, not the caller');
    } };
  });
  add('PUT /v1/hub/accounts/{slotId}/admin/*', 200, async (principal) => {
    const b = await browser();
    const { admin, slotId } = await enrolled(b);
    const value = { matrix: randomBytes(4).toString('hex') };
    return { url: `/v1/hub/accounts/${slotId}/admin/preferences/hub-matrix`, env: peer(),
      init: { method: 'PUT', headers: { ...b.headers(principal), 'x-store-slug': fixture.storeSlug }, body: JSON.stringify({ value }) }, async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { key: 'hub-matrix', value }, 'target answer relayed');
        proof.equal(await global("SELECT value FROM admin_preference WHERE admin_user_id=$1 AND key='hub-matrix'", [admin.id]), [{ value }], 'written as the saved account', 'state');
      } };
  });
  // Credential management never passes through the hub: refused before any call to the target, for every caller.
  for (const [key, sub] of [['POST /v1/hub/accounts/{slotId}/admin/*', 'logout'], ['PATCH /v1/hub/accounts/{slotId}/admin/*', 'password'],
    ['DELETE /v1/hub/accounts/{slotId}/admin/*', 'api-tokens/matrix']] as const) {
    add(key, 400, async (principal) => {
      const b = await browser();
      const { slotId } = await enrolled(b);
      const url = `/v1/hub/accounts/${slotId}/admin/${sub}`;
      return { url, env: peer(), init: { method: method(key), headers: b.headers(principal), body: '{}' },
        snapshot: fixture.snapshotFor(principal, method(key), new URL(url, HUB).pathname, 400),
        async verify(response: Response, proof: MatrixProof) {
          proof.equal(((await response.json()) as { error?: { code?: string } }).error?.code, 'HUB_PATH_REFUSED', 'credential paths are not relayed');
          proof.equal(await global('SELECT 1 FROM hub_account_slot WHERE id=$1', [slotId]), [{ '?column?': 1 }], 'saved account untouched', 'state');
        } };
    }, 'HUB_PATH_REFUSED');
  }
  return cases;
}
