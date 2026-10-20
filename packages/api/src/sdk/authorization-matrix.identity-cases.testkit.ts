/** Genuine identity/session contracts for B2.8; source-only, never packed into engine. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createAdminSession } from '../auth/admin-session.js';
import { hashAgentToken, newAgentToken } from '../auth/admin-api-token.js';
import { openTotpSecret } from '../auth/totp-secret.js';
import { verifyPassword } from '../auth/password.js';
import { newTotpSecret, otpauthUri } from '../auth/totp.js';
import { type MatrixCase, type MatrixCell, type MatrixPrincipal, type MatrixProof } from './authorization-matrix.testkit.js';

type Identity = { id: string; email: string; password: string; token: string; totpSecret: string | null };
type FreshIdentity = Identity & { headers: Record<string, string> };
export interface MatrixIdentityFixture {
  storeId: string; storeSlug: string; foreignStoreId: string;
  requestHeaders: Record<MatrixPrincipal, Record<string, string>>;
  identityFor(principal: string): Identity;
  freshIdentity(principal: MatrixPrincipal, options?: { enrolled?: boolean }): Promise<FreshIdentity>;
  request(url: string, init?: RequestInit, env?: Record<string, unknown>): Response | Promise<Response>;
  queryGlobal(sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
  queryStore(storeId: string, sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
  snapshot(): Promise<unknown>;
  snapshotFor(principal: MatrixPrincipal, method: string, path: string, status?: number, hardAgentGroup?: string): () => Promise<unknown>;
}
type Outcomes = Record<MatrixPrincipal, number>;
const MANAGE: Outcomes = { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 };
const HUMAN: Outcomes = { owner: 200, manager: 200, staff: 200, read_only: 200, agent: 403, foreign_store: 200, release_service: 401, cache_token: 401 };
const INSTALL: Outcomes = { owner: 403, manager: 403, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 };
const OWNER: Outcomes = { owner: 200, manager: 403, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 };
const OFFSITE: Outcomes = { owner: 200, manager: 200, staff: 200, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 };
const DEVICES: Outcomes = { owner: 200, manager: 200, staff: 200, read_only: 200, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 };
const BROWSER: Outcomes = { owner: 403, manager: 403, staff: 403, read_only: 403, agent: 200, foreign_store: 403, release_service: 401, cache_token: 401 };
const PUBLIC: Outcomes = { owner: 200, manager: 200, staff: 200, read_only: 200, agent: 200, foreign_store: 200, release_service: 200, cache_token: 200 };
const ACCEPT: Outcomes = { owner: 200, manager: 200, staff: 200, read_only: 200, agent: 403, foreign_store: 200, release_service: 200, cache_token: 200 };
const CHECKLIST: Outcomes = { owner: 200, manager: 200, staff: 200, read_only: 200, agent: 200, foreign_store: 403, release_service: 401, cache_token: 401 };
const DISABLE: Outcomes = { owner: 403, manager: 403, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 };
const MESSAGES: Record<string, string> = {
  identity: 'agents cannot manage staff or agents',
  delete: 'agents cannot delete — disable or trash instead; deletion needs a human',
  credentials: 'agents cannot change credentials or payment/e-mail secrets',
  system: 'agents cannot run system operations',
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (response: Response) => response.json() as Promise<Record<string, any>>;
type Prepared = { url: string; body?: unknown; headers?: Record<string, string>; verify?(response: Response, proof: MatrixProof): Promise<void> };
/** Independent RFC 6238 code generation; real verifier consumes each disposable identity's step once. */
function totp(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.toUpperCase().replace(/=+$/, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(), offset = h[h.length - 1]! & 15;
  return ((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}
function factorCode(identity: Identity): string {
  if (!identity.totpSecret) throw new Error('identity matrix requires genuinely enrolled factor');
  return totp(identity.totpSecret);
}
const recoveryHash = (code: string) => digest('sellright-recovery:' + code.toLowerCase().replace(/[^a-z2-7]/g, ''));
const cookiesToken = (response: Response): string => {
  const token = /(?:^|[, ]+)sr_admin=([^;, ]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
  if (!token) throw new Error('identity matrix response did not set session cookie');
  return token;
};

export function createIdentityCases(fixture: MatrixIdentityFixture): MatrixCase[] {
  const cases: MatrixCase[] = [];
  let peerId = 0;
  const peer = () => ({ remoteAddr: '192.0.2.' + (++peerId % 250 + 1) });
  const identityHeaders = (identity: Identity) => ({ authorization: 'Bearer ' + identity.token, 'x-store-slug': fixture.storeSlug, 'content-type': 'application/json' });
  const global = async (sql: string, values: unknown[] = []) => (await fixture.queryGlobal(sql, values)).rows;
  const query = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  const one = async (sql: string, values: unknown[] = []) => {
    const rows = await global(sql, values); if (rows.length !== 1) throw new Error('identity matrix expected exactly one row'); return rows[0]!;
  };
  const success = async (response: Response, proof: MatrixProof) => proof.equal(await json(response), { ok: true }, 'exact success response');
  const add = (key: string, outcomes: Outcomes, prepare: (principal: MatrixPrincipal, allow: boolean) => Promise<Prepared>,
    options: { contract?: MatrixCase['contract']; group?: string; denial?: 'install' | 'browser' | 'device' | 'policy' | 'write' | 'owner' } = {}) => {
    const method = key.split(' ')[0]!;
    const make = (principal: MatrixPrincipal): MatrixCell => {
      const status = outcomes[principal], allow = status === 200;
      return { effect: allow ? 'allow' : 'deny', status,
        ...(principal === 'agent' && !allow && options.group ? { errorCode: 'AGENT_NOT_ALLOWED' } : {}),
        async prepare() {
          const prepared = await prepare(principal, allow);
          return { url: prepared.url, env: peer(), init: { method, headers: prepared.headers ?? fixture.requestHeaders[principal],
            ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }) },
            ...(allow ? {} : { snapshot: fixture.snapshotFor(principal, method, prepared.url, status, principal === 'agent' ? options.group : undefined) }),
            async verify(response: Response, proof: MatrixProof) {
              if (allow) {
                if (!prepared.verify) throw new Error('identity allow requires response & state assertions');
                return prepared.verify(response, proof);
              }
              const body = await json(response);
              if (status === 401) { proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'service/cache credential is not an admin session'); return; }
              if (principal === 'agent' && options.group) {
                proof.equal(body.error?.code, 'AGENT_NOT_ALLOWED', 'genuine sra agent hits hard boundary');
                proof.equal(body.error?.message, MESSAGES[options.group], 'exact hard boundary reason'); return;
              }
              if (options.denial === 'install') { proof.equal(body.error?.message, 'requires installation administrator', 'ordinary store owner has no install authority'); return; }
              if (options.denial === 'browser') { proof.equal(body.error?.message, 'browser-session requires an agent API token bearer', 'human sessions cannot become token-bound agents'); return; }
              if (options.denial === 'policy') { proof.equal(body.error?.code, 'TOTP_REQUIRED', 'required enrolled factor cannot be disabled'); return; }
              if (principal === 'foreign_store') { proof.equal(body.error?.message, `no access to store: ${fixture.storeSlug}`, 'store B identity cannot act on existing A target'); return; }
              if (options.denial === 'owner') { proof.equal(body.error?.message, `role '${principal}' cannot manage owner-level access`, 'owner-only security policy'); return; }
              if (options.denial === 'device' && principal === 'agent') { proof.equal(body.error?.code, 'SESSION_REQUIRED', 'API token has no session for device registration'); return; }
              proof.equal(body.error?.message, options.denial === 'write' ? "role 'read_only' is read-only" : `role '${principal}' cannot manage settings/staff`, 'explicit role boundary');
            } };
        } };
    };
    cases.push({ key, contract: options.contract ?? 'admin', cells: {
      owner: make('owner'), manager: make('manager'), staff: make('staff'), read_only: make('read_only'),
      agent: make('agent'), foreign_store: make('foreign_store'), release_service: make('release_service'), cache_token: make('cache_token'),
    } });
  };
  const targetHuman = () => fixture.freshIdentity('staff');
  const seedAgent = async () => {
    const id = randomUUID(), tokenId = randomUUID(), token = newAgentToken(), sessionToken = randomBytes(32).toString('hex');
    await global("INSERT INTO admin_user(id,email,kind,password_hash,name) VALUES($1,$2,'agent',NULL,'Agent: Matrix target')", [id, `target-${id}@agents.invalid`]);
    await global("INSERT INTO admin_user_store(admin_user_id,store_id,role) VALUES($1,$2,'staff')", [id, fixture.storeId]);
    await query("INSERT INTO admin_api_token(id,admin_user_id,store_id,name,token_hash,expires_at) VALUES($1,$2,$3,'Matrix target',$4,now()+interval '1 hour')", [tokenId, id, fixture.storeId, hashAgentToken(token)]);
    await global("INSERT INTO session(admin_user_id,token_hash,api_token_id,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')", [id, digest(sessionToken), tokenId]);
    return { id, tokenId, token, sessionToken };
  };
  const seedInvite = async (email: string) => {
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    await global("INSERT INTO staff_invite(id,store_id,email,role,token_hash,expires_at) VALUES($1,$2,$3,'staff',$4,now()+interval '1 hour')", [id, fixture.storeId, email, digest(token)]);
    return { id, token };
  };
  add('POST /v1/admin/staff', MANAGE, async () => {
    const target = await targetHuman(), original = await one('SELECT password_hash FROM admin_user WHERE id=$1', [target.id]);
    return { url: '/v1/admin/staff', body: { email: target.email, role: 'manager', password: 'matrix-unused-existing-password' },
      async verify(response: Response, proof: MatrixProof) {
        proof.equal(await json(response), { adminUserId: target.id }, 'existing A staff identified');
        proof.equal(await global('SELECT role FROM admin_user_store WHERE admin_user_id=$1 AND store_id=$2', [target.id, fixture.storeId]), [{ role: 'manager' }], 'existing member role committed', 'state');
        proof.equal((await one('SELECT password_hash FROM admin_user WHERE id=$1', [target.id])).password_hash, original.password_hash, 'existing credentials preserved', 'state');
      } };
  }, { group: 'identity' });
  add('PATCH /v1/admin/staff/{adminUserId}', MANAGE, async () => {
    const target = await targetHuman(); await seedInvite(target.email);
    return { url: `/v1/admin/staff/${target.id}`, body: { role: 'read_only' }, async verify(response: Response, proof: MatrixProof) {
      await success(response, proof);
      proof.equal(await global('SELECT role FROM admin_user_store WHERE admin_user_id=$1 AND store_id=$2', [target.id, fixture.storeId]), [{ role: 'read_only' }], 'staff demotion committed', 'state');
      proof.equal(await global('SELECT id FROM staff_invite WHERE email=$1 AND accepted_at IS NULL', [target.email]), [], 'stale invitations revoked', 'state');
    } };
  }, { group: 'identity' });
  add('DELETE /v1/admin/staff/{adminUserId}', MANAGE, async () => {
    const target = await targetHuman(); await seedInvite(target.email);
    return { url: `/v1/admin/staff/${target.id}`, async verify(response: Response, proof: MatrixProof) {
      await success(response, proof);
      proof.equal(await global('SELECT role FROM admin_user_store WHERE admin_user_id=$1 AND store_id=$2', [target.id, fixture.storeId]), [], 'A membership removed', 'state');
      proof.equal(await global('SELECT id FROM staff_invite WHERE email=$1 AND accepted_at IS NULL', [target.email]), [], 'stale invitation removed', 'state');
    } };
  }, { group: 'delete' });
  add('PUT /v1/admin/staff/{adminUserId}/permissions', MANAGE, async () => {
    const target = await targetHuman();
    await global("UPDATE admin_user_store SET permissions='{\"matrix_future\":true,\"refunds\":true}' WHERE admin_user_id=$1 AND store_id=$2", [target.id, fixture.storeId]);
    const permissions = { matrix_future: true, giftcards: true };
    return { url: `/v1/admin/staff/${target.id}/permissions`, body: { permissions: { giftcards: true, refunds: false } }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { adminUserId: target.id, permissions }, 'merged permission projection');
      proof.equal(await global('SELECT permissions FROM admin_user_store WHERE admin_user_id=$1 AND store_id=$2', [target.id, fixture.storeId]), [{ permissions }], 'known permissions changed & unknown keys preserved', 'state');
    } };
  }, { group: 'identity' });
  add('POST /v1/admin/staff/{adminUserId}/revoke-sessions', MANAGE, async () => {
    const target = await targetHuman(); await createAdminSession(target.id);
    return { url: `/v1/admin/staff/${target.id}/revoke-sessions`, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { revoked: 2 }, 'both target sessions revoked');
      proof.equal(await global('SELECT id FROM session WHERE admin_user_id=$1', [target.id]), [], 'target has no live sessions', 'state');
      proof.equal(await global('SELECT role FROM admin_user_store WHERE admin_user_id=$1 AND store_id=$2', [target.id, fixture.storeId]), [{ role: 'staff' }], 'membership preserved', 'state');
    } };
  }, { group: 'identity' });
  add('POST /v1/admin/staff/accept', ACCEPT, async () => {
    const email = `accepted-${randomUUID()}@matrix.invalid`, invite = await seedInvite(email);
    return { url: '/v1/admin/staff/accept', body: { token: invite.token, password: 'matrix-accepted-password' }, async verify(response: Response, proof: MatrixProof) {
      await success(response, proof);
      const account = await one('SELECT id,password_hash FROM admin_user WHERE email=$1', [email]);
      proof.ok(await verifyPassword('matrix-accepted-password', account.password_hash), 'invitee chosen password committed', 'state');
      proof.equal(await global('SELECT role FROM admin_user_store WHERE admin_user_id=$1 AND store_id=$2', [account.id, fixture.storeId]), [{ role: 'staff' }], 'invite capability enrolls exactly A', 'state');
      proof.equal(await global('SELECT accepted_at IS NOT NULL AS accepted FROM staff_invite WHERE id=$1', [invite.id]), [{ accepted: true }], 'one-time capability consumed', 'state');
    } };
  }, { contract: 'capability', group: 'identity' });
  add('POST /v1/admin/agents', MANAGE, async () => {
    const name = `Matrix seat ${randomUUID()}`, expiry = new Date(Date.now() + 3_600_000).toISOString();
    return { url: '/v1/admin/agents', body: { name, role: 'staff', expiresAt: expiry }, async verify(response: Response, proof: MatrixProof) {
      const body = await json(response);
      proof.equal(Object.keys(body).sort(), ['adminUserId', 'email', 'id', 'role', 'token'], 'one-time agent token response');
      proof.equal(body.role, 'staff', 'requested agent role'); proof.ok(typeof body.token === 'string' && body.token.startsWith('sra_'), 'genuine opaque agent bearer');
      proof.equal(await global('SELECT kind,password_hash FROM admin_user WHERE id=$1', [body.adminUserId]), [{ kind: 'agent', password_hash: null }], 'agent has no human password', 'state');
      proof.equal(await query('SELECT admin_user_id,store_id,token_hash,name,expires_at FROM admin_api_token WHERE id=$1', [body.id]), [{ admin_user_id: body.adminUserId, store_id: fixture.storeId, token_hash: hashAgentToken(body.token), name, expires_at: new Date(expiry) }], 'only token hash & A binding committed', 'state');
    } };
  }, { group: 'identity' });
  add('POST /v1/admin/agents/{adminUserId}/rotate', MANAGE, async () => {
    const target = await seedAgent();
    return { url: `/v1/admin/agents/${target.id}/rotate`, async verify(response: Response, proof: MatrixProof) {
      const body = await json(response); proof.equal(body.revoked, 1, 'one old token revoked'); proof.ok(body.token.startsWith('sra_') && body.token !== target.token, 'fresh genuine token returned');
      proof.equal(await query('SELECT revoked_at IS NOT NULL AS revoked FROM admin_api_token WHERE id=$1', [target.tokenId]), [{ revoked: true }], 'old token unusable', 'state');
      proof.equal(await global('SELECT id FROM session WHERE api_token_id=$1', [target.tokenId]), [], 'old token browser sessions revoked', 'state');
      proof.equal(await query('SELECT token_hash,admin_user_id FROM admin_api_token WHERE id=$1', [body.id]), [{ token_hash: hashAgentToken(body.token), admin_user_id: target.id }], 'replacement belongs to same A agent', 'state');
    } };
  }, { group: 'identity' });
  add('DELETE /v1/admin/agents/{adminUserId}', MANAGE, async () => {
    const target = await seedAgent();
    return { url: `/v1/admin/agents/${target.id}`, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { ok: true, revoked: 1 }, 'removed target token count');
      proof.equal(await global('SELECT id FROM session WHERE admin_user_id=$1', [target.id]), [], 'all target agent sessions removed', 'state');
      proof.equal(await global('SELECT role FROM admin_user_store WHERE admin_user_id=$1 AND store_id=$2', [target.id, fixture.storeId]), [], 'target A seat removed', 'state');
      proof.equal(await query('SELECT revoked_at IS NOT NULL AS revoked FROM admin_api_token WHERE id=$1', [target.tokenId]), [{ revoked: true }], 'raw agent bearer revoked', 'state');
    } };
  }, { group: 'delete' });
  add('POST /v1/admin/agents/browser-session', BROWSER, async () => ({
    url: '/v1/admin/agents/browser-session', async verify(response: Response, proof: MatrixProof) {
      const body = await json(response), token = cookiesToken(response), who = fixture.identityFor('agent');
      proof.equal(body.ok, true, 'agent bootstrap success'); proof.ok(typeof body.csrfToken === 'string' && body.csrfToken.length >= 32, 'csrf secret returned');
      proof.ok(body.expiresInSeconds > 0 && body.expiresInSeconds <= 3600, 'session bounded by fixture token expiry');
      const stored = await one('SELECT admin_user_id,api_token_id FROM session WHERE token_hash=$1', [digest(token)]);
      proof.equal(stored.admin_user_id, who.id, 'cookie session belongs to actual agent', 'state');
      proof.equal(await query('SELECT id FROM admin_api_token WHERE token_hash=$1', [hashAgentToken(who.token)]), [{ id: stored.api_token_id }], 'cookie bound to supplied live token', 'state');
      proof.equal(await global('SELECT count(*)::int AS n FROM session WHERE api_token_id=$1', [stored.api_token_id]), [{ n: 1 }], 'one live browser session per token', 'state');
    },
  }), { denial: 'browser' });
  add('POST /v1/admin/login', PUBLIC, async () => {
    // Public login authenticates body credentials; an unrelated supplied principal grants nothing.
    const target = await targetHuman(), before = (await global('SELECT id FROM session WHERE admin_user_id=$1', [target.id])).length;
    return { url: '/v1/admin/login', body: { email: target.email, password: target.password, totp: factorCode(target), returnToken: true }, async verify(response: Response, proof: MatrixProof) {
      const body = await json(response);
      proof.equal(body.admin, { email: target.email }, 'body credential selects human account');
      proof.equal(body.token, cookiesToken(response), 'explicit API token agrees with secure cookie');
      proof.equal(body.stores.map((s: any) => [s.storeId, s.role]), [[fixture.storeId, 'staff']], 'only target A grant returned');
      proof.equal(await global('SELECT admin_user_id,api_token_id FROM session WHERE token_hash=$1', [digest(body.token)]), [{ admin_user_id: target.id, api_token_id: null }], 'genuine human session persisted', 'state');
      proof.equal((await global('SELECT id FROM session WHERE admin_user_id=$1', [target.id])).length, before + 1, 'exactly one session created', 'state');
    } };
  }, { contract: 'public' });
  add('POST /v1/admin/logout', PUBLIC, async principal => {
    const human = ['owner', 'manager', 'staff', 'read_only', 'foreign_store'].includes(principal);
    const target = human ? await fixture.freshIdentity(principal) : null;
    const headers = (target ? identityHeaders(target) : undefined) ?? { ...fixture.requestHeaders[principal], cookie: 'sr_csrf=matrix-logout', 'x-csrf-token': 'matrix-logout' };
    const before = target ? undefined : await fixture.snapshot();
    return { url: '/v1/admin/logout', headers, async verify(response: Response, proof: MatrixProof) {
      await success(response, proof); proof.ok((response.headers.get('set-cookie') ?? '').includes('Max-Age=0'), 'browser auth cookies cleared');
      if (target) proof.equal(await global('SELECT id FROM session WHERE token_hash=$1', [digest(target.token)]), [], 'only disposable authenticated session deleted', 'state');
      else proof.equal(await fixture.snapshot(), before, 'public idempotent logout cannot revoke API/service/cache credentials', 'state');
    } };
  }, { contract: 'public' });
  add('POST /v1/admin/step-up', HUMAN, async (principal, allow) => {
    const target = allow ? await fixture.freshIdentity(principal) : fixture.identityFor('owner');
    return { url: '/v1/admin/step-up', ...(allow ? { headers: identityHeaders(target) } : {}), body: { password: target.password, totp: factorCode(target) }, async verify(response: Response, proof: MatrixProof) {
      await success(response, proof);
      const state = await one('SELECT step_up_at FROM session WHERE token_hash=$1', [digest(target.token)]);
      proof.ok(state.step_up_at instanceof Date && Math.abs(Date.now() - state.step_up_at.getTime()) < 30_000, 'real current credential proof persisted on this session', 'state');
    } };
  }, { group: 'credentials' });
  add('POST /v1/admin/password', HUMAN, async (principal, allow) => {
    const target = allow ? await fixture.freshIdentity(principal) : fixture.identityFor('owner'), next = `matrix-new-${randomUUID()}`;
    if (allow) {
      const stepped = await fixture.request('/v1/admin/step-up', { method: 'POST', headers: identityHeaders(target), body: JSON.stringify({ password: target.password, totp: factorCode(target) }) }, peer());
      assert.equal(stepped.status, 200, 'password fixture must earn recent step-up through real route');
      await createAdminSession(target.id);
    }
    return { url: '/v1/admin/password', ...(allow ? { headers: identityHeaders(target) } : {}), body: { currentPassword: target.password, newPassword: next }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { ok: true, revokedSessions: 1 }, 'other session revoked count');
      const state = await one('SELECT password_hash FROM admin_user WHERE id=$1', [target.id]);
      proof.ok(await verifyPassword(next, state.password_hash), 'replacement password committed', 'state');
      proof.equal(await verifyPassword(target.password, state.password_hash), false, 'old password invalid', 'state');
      proof.equal(await global('SELECT token_hash FROM session WHERE admin_user_id=$1', [target.id]), [{ token_hash: digest(target.token) }], 'stepped-up session alone retained', 'state');
    } };
  }, { group: 'credentials' });
  add('POST /v1/admin/2fa/setup', HUMAN, async (principal, allow) => {
    const target = allow ? await fixture.freshIdentity(principal) : fixture.identityFor('owner');
    const before = await one('SELECT totp_secret FROM admin_user WHERE id=$1', [target.id]);
    return { url: '/v1/admin/2fa/setup', ...(allow ? { headers: identityHeaders(target) } : {}), async verify(response: Response, proof: MatrixProof) {
      const body = await json(response); proof.ok(/^[A-Z2-7]{32}$/.test(body.secret), 'valid new 160-bit authenticator secret');
      proof.equal(body.otpauthUri, otpauthUri(body.secret, target.email), 'QR identity binds actual human');
      proof.equal(await global('SELECT totp_secret FROM admin_user WHERE id=$1', [target.id]), [before], 'setup returns ephemeral secret without replacing existing factor', 'state');
    } };
  }, { group: 'credentials' });
  const verifyRecovery = async (response: Response, proof: MatrixProof, target: Identity, enabled: boolean) => {
    const body = await json(response);
    proof.equal(Object.keys(body).sort(), enabled ? ['enabled', 'recoveryCodes'] : ['recoveryCodes'], 'one-time recovery response fields');
    if (enabled) proof.equal(body.enabled, true, 'new factor enabled');
    proof.equal(body.recoveryCodes.length, 10, 'ten one-time recovery codes'); proof.equal(new Set(body.recoveryCodes).size, 10, 'distinct recovery codes');
    const rows = await global('SELECT code_hash,used_at FROM admin_recovery_code WHERE admin_user_id=$1 ORDER BY code_hash', [target.id]);
    proof.equal(rows, body.recoveryCodes.map((code: string) => ({ code_hash: recoveryHash(code), used_at: null })).sort((a: any, b: any) => a.code_hash.localeCompare(b.code_hash)), 'only returned recovery hashes persisted', 'state');
  };
  add('POST /v1/admin/2fa/enable', HUMAN, async (principal, allow) => {
    const target = allow ? await fixture.freshIdentity(principal, { enrolled: false }) : fixture.identityFor('owner'), secret = newTotpSecret();
    if (allow) await createAdminSession(target.id);
    return { url: '/v1/admin/2fa/enable', ...(allow ? { headers: identityHeaders(target) } : {}), body: { secret, code: totp(secret), password: target.password }, async verify(response: Response, proof: MatrixProof) {
      await verifyRecovery(response, proof, target, true);
      const state = await one('SELECT totp_secret FROM admin_user WHERE id=$1', [target.id]);
      proof.equal(openTotpSecret(target.id, state.totp_secret), secret, 'new proven factor sealed & committed', 'state');
      proof.ok(state.totp_secret !== secret, 'plaintext factor not persisted', 'state');
      proof.equal(await global('SELECT token_hash FROM session WHERE admin_user_id=$1', [target.id]), [{ token_hash: digest(target.token) }], 'other pre-enrollment session revoked', 'state');
    } };
  }, { group: 'credentials' });
  add('POST /v1/admin/2fa/disable', DISABLE, async principal => {
    const target = ['agent', 'release_service', 'cache_token'].includes(principal) ? fixture.identityFor('owner') : fixture.identityFor(principal);
    return { url: '/v1/admin/2fa/disable', body: { password: target.password, code: factorCode(target) } };
  }, { group: 'credentials', denial: 'policy' });
  add('POST /v1/admin/2fa/recovery-codes', HUMAN, async (principal, allow) => {
    const target = allow ? await fixture.freshIdentity(principal) : fixture.identityFor('owner');
    const staleCode = 'aaaa-bbbb-cccc-dddd';
    if (allow) await global('INSERT INTO admin_recovery_code(admin_user_id,code_hash) VALUES($1,$2)', [target.id, recoveryHash(staleCode)]);
    return { url: '/v1/admin/2fa/recovery-codes', ...(allow ? { headers: identityHeaders(target) } : {}), body: { password: target.password, code: factorCode(target) }, async verify(response: Response, proof: MatrixProof) {
      await verifyRecovery(response, proof, target, false);
      proof.equal(await global('SELECT id FROM admin_recovery_code WHERE admin_user_id=$1 AND code_hash=$2', [target.id, recoveryHash(staleCode)]), [], 'prior recovery set invalidated', 'state');
    } };
  }, { group: 'credentials' });
  add('PATCH /v1/admin/settings/security', OWNER, async (principal, allow) => {
    const target = allow ? await fixture.freshIdentity(principal) : fixture.identityFor('owner');
    if (allow) {
      const step = await fixture.request('/v1/admin/step-up', { method: 'POST', headers: identityHeaders(target), body: JSON.stringify({ password: target.password, totp: factorCode(target) }) }, peer());
      assert.equal(step.status, 200, 'security policy fixture earns genuine recent step-up');
    }
    await query("UPDATE store SET config=jsonb_set(config,'{security}','{\"requireTotp\":false}'::jsonb,true) WHERE id=$1", [fixture.storeId]);
    return { url: '/v1/admin/settings/security', ...(allow ? { headers: identityHeaders(target) } : {}), body: { requireTotp: true }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { requireTotp: true, installRequireTotp: 'all' }, 'owner security policy projection');
      proof.equal(await query("SELECT config->'security'->'requireTotp' AS required FROM store WHERE id=$1", [fixture.storeId]), [{ required: true }], 'store A enrollment requirement committed', 'state');
    } };
  }, { group: 'credentials', denial: 'owner' });
  add('GET /v1/admin/system/checklist', CHECKLIST, async () => ({
    url: '/v1/admin/system/checklist', async verify(response: Response, proof: MatrixProof) {
      const body = await json(response); proof.equal(Object.keys(body).sort(), ['domain', 'email', 'offSiteBackup', 'payments', 'products', 'recoveryKit', 'shippingAndTax'], 'exact readiness dimensions');
      proof.equal(body.products, { ok: true, detail: 'At least one active product' }, 'existing active A product observed');
      proof.equal(body.recoveryKit, { ok: false, detail: 'Not downloaded yet' }, 'ordinary admin does not inherit install recovery state');
    },
  }));
  add('GET /v1/admin/system/recovery-kit', INSTALL, async () => ({
    url: '/v1/admin/system/recovery-kit',
  }), { denial: 'install' });
  add('PATCH /v1/admin/system/checklist/offsite-backup-confirmed', OFFSITE, async () => {
    await query("UPDATE store SET config=jsonb_set(config,'{checklist}','{\"offsiteBackupConfirmed\":false}'::jsonb,true) WHERE id=$1", [fixture.storeId]);
    return { url: '/v1/admin/system/checklist/offsite-backup-confirmed', body: { confirmed: true }, async verify(response: Response, proof: MatrixProof) {
      await success(response, proof);
      proof.equal(await query("SELECT config->'checklist'->'offsiteBackupConfirmed' AS confirmed FROM store WHERE id=$1", [fixture.storeId]), [{ confirmed: true }], 'offsite confirmation committed for A', 'state');
    } };
  }, { group: 'system', denial: 'write' });
  add('POST /v1/admin/system/canary', INSTALL, async () => ({
    url: '/v1/admin/system/canary', body: { slot: 123, channels: ['email'], kinds: ['order_confirmation'] },
  }), { group: 'system', denial: 'install' });
  add('POST /v1/admin/devices', DEVICES, async principal => {
    const token = randomBytes(32).toString('hex'), topics = ['order.paid'];
    return { url: '/v1/admin/devices', body: { token, kind: 'apns', environment: 'sandbox', topics }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { ok: true, topics }, 'registered subscription response');
      const who = fixture.identityFor(principal);
      const session = await one('SELECT id FROM session WHERE token_hash=$1', [digest(who.token)]);
      proof.equal(await query('SELECT admin_user_id,store_id,session_id,kind,environment,topics FROM admin_device_token WHERE token=$1', [token]), [{ admin_user_id: who.id, store_id: fixture.storeId, session_id: session.id, kind: 'apns', environment: 'sandbox', topics }], 'device bound to actual human session & A', 'state');
    } };
  }, { denial: 'device' });
  add('DELETE /v1/admin/devices/{token}', DEVICES, async principal => {
    const token = randomBytes(32).toString('hex');
    const who = ['owner', 'manager', 'staff', 'read_only'].includes(principal) ? fixture.identityFor(principal) : await targetHuman();
    const session = await one('SELECT id FROM session WHERE token_hash=$1', [digest(who.token)]);
    await query('INSERT INTO admin_device_token(store_id,admin_user_id,session_id,token) VALUES($1,$2,$3,$4)', [fixture.storeId, who.id, session.id, token]);
    return { url: `/v1/admin/devices/${token}`, async verify(response: Response, proof: MatrixProof) {
      await success(response, proof); proof.equal(await query('SELECT id FROM admin_device_token WHERE token=$1', [token]), [], 'existing current-operator A device removed', 'state');
    } };
  }, { group: 'delete' });
  return cases;
}

/** Extra positive controls keep install authority separate from all eight ordinary principals. */
export async function runIdentityControls(fixture: MatrixIdentityFixture): Promise<void> {
  // Existing account invitations additionally require that account's consent; owner A is not its credential.
  const invited = await fixture.freshIdentity('foreign_store');
  const inviteId = randomUUID(), inviteToken = randomBytes(32).toString('hex');
  await fixture.queryGlobal("INSERT INTO staff_invite(id,store_id,email,role,token_hash,expires_at) VALUES($1,$2,$3,'staff',$4,now()+interval '1 hour')", [inviteId, fixture.storeId, invited.email, digest(inviteToken)]);
  const original = (await fixture.queryGlobal('SELECT password_hash FROM admin_user WHERE id=$1', [invited.id])).rows;
  const snapshot = fixture.snapshotFor('owner', 'POST', '/v1/admin/staff/accept', 401);
  const before = await snapshot();
  const rejected = await fixture.request('/v1/admin/staff/accept', { method: 'POST', headers: fixture.requestHeaders.owner, body: JSON.stringify({ token: inviteToken }) });
  assert.equal(rejected.status, 401);
  assert.equal((await json(rejected)).error?.code, 'INVITE_SIGN_IN_REQUIRED');
  assert.deepEqual(await snapshot(), before, 'owner A cannot redeem an existing account invitation without its consent');
  const accepted = await fixture.request('/v1/admin/staff/accept', { method: 'POST', headers: invited.headers, body: JSON.stringify({ token: inviteToken }) });
  assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { ok: true });
  assert.deepEqual((await fixture.queryGlobal('SELECT password_hash FROM admin_user WHERE id=$1', [invited.id])).rows, original);
  assert.deepEqual((await fixture.queryGlobal('SELECT role FROM admin_user_store WHERE admin_user_id=$1 AND store_id=$2', [invited.id, fixture.storeId])).rows, [{ role: 'staff' }]);
  assert.deepEqual((await fixture.queryGlobal('SELECT role FROM admin_user_store WHERE admin_user_id=$1 AND store_id=$2', [invited.id, fixture.foreignStoreId])).rows, [{ role: 'owner' }]);
  const install = fixture.identityFor('installation_admin');
  const headers = { authorization: `Bearer ${install.token}`, 'x-store-slug': fixture.storeSlug, 'content-type': 'application/json' };
  const step = await fixture.request('/v1/admin/step-up', { method: 'POST', headers, body: JSON.stringify({ password: install.password, totp: factorCode(install) }) }, { remoteAddr: '198.51.100.253' });
  assert.equal(step.status, 200, 'installation administrator earns real recent step-up');
  assert.deepEqual(await step.json(), { ok: true });
  const recovery = await fixture.request('/v1/admin/system/recovery-kit', { headers });
  assert.equal(recovery.status, 200);
  const kit = await json(recovery);
  assert.equal(kit.masterKeyPresent, true); assert.match(kit.masterKey, /^[a-f0-9]{64}$/i);
  assert.equal(typeof kit.note, 'string'); assert.ok(Number.isFinite(Date.parse(kit.generatedAt)));
  assert.deepEqual((await fixture.queryGlobal('SELECT recovery_kit_downloaded_at IS NOT NULL AS downloaded FROM admin_user WHERE id=$1', [install.id])).rows, [{ downloaded: true }]);
  const recipient = `canary-${randomUUID()}@matrix.invalid`;
  await fixture.queryStore(fixture.storeId, "UPDATE store SET config=jsonb_set(config,'{health}',jsonb_build_object('canary',jsonb_build_object('email',$2::text)),true) WHERE id=$1", [fixture.storeId, recipient]);
  const canary = await fixture.request('/v1/admin/system/canary', { method: 'POST', headers, body: JSON.stringify({ slot: 123, channels: ['email'], kinds: ['order_confirmation'] }) });
  assert.equal(canary.status, 200);
  const body = await json(canary);
  assert.equal(body.slot, 123); assert.deepEqual(body.skipped, []); assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].channel, 'email'); assert.equal(body.rows[0].kind, 'order_confirmation');
  const row = (await fixture.queryStore(fixture.storeId, "SELECT recipient,kind,status,payload->>'canary' AS canary FROM email_outbox WHERE id=$1", [body.rows[0].id])).rows;
  assert.deepEqual(row, [{ recipient, kind: 'order_confirmation', status: 'pending', canary: 'true' }]);
}
