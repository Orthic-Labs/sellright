/** B2.8 license, device, signed-download & release credentials. Test source only. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../env.js';
import { slugifyCode } from '../lib/api-error.js';
import { SESSION_COOKIE } from '../auth/cookies.js';
import { hashActivationToken } from '../licensing/tokens.js';
import { signedDownloadPath, verifyDownloadSig } from '../licensing/download-url.js';
import { appKeyHeaderNames, deviceHeaderName } from '../licensing/app-headers.js';
import type { ReleaseRegistrationPolicy } from '../releases/registration-policy.js';
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import { PRINCIPALS, type MatrixCase, type MatrixCell, type MatrixPrincipal, type MatrixProof, type PreparedMatrixCell } from './authorization-matrix.testkit.js';

type Fixture = Awaited<ReturnType<typeof createAuthorizationFixtures>>;
type Json = Record<string, any>;
export interface LicenseControl { key: string; status: number; prepare(): Promise<PreparedMatrixCell> }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const payload = Buffer.from('Synthetic authorization matrix artifact; never distribute.\n');
const bodyAliases = ['/api/licenses', '/v1/licenses'];
const activationActions = ['activate', 'refresh', 'deactivate'] as const;
type Action = (typeof activationActions)[number];

/** Root installs this policy before boot, then binds storeSlug after fixture creation. */
export function createMatrixReleasePolicy(releaseToken: string): ReleaseRegistrationPolicy {
  return { channels: ['stable'], serviceCredential: { sha256: digest(releaseToken), storeSlug: 'pending-matrix' } };
}

function licenseSource(f: Fixture) {
  const rows = async (sql: string, values: unknown[] = []) => (await f.queryStore(f.storeId, sql, values)).rows;
  async function seed() {
    const id = randomUUID(), activationId = randomUUID(), releaseId = randomUUID(), artifactId = randomUUID();
    const key = 'MATRIX-LICENSE-' + id, token = 'sr_act_matrix_' + activationId, device = 'matrix-device-' + activationId;
    const artifactKey = 'matrix-artifact-' + artifactId, path = artifactKey + '.bin', channel = 'matrix-' + releaseId;
    const manifest = { version: '1.0.0-' + releaseId, notes: 'Synthetic authorization fixture', artifactKey };
    await writeFile(join(env.DOWNLOAD_DIR, path), payload, { flag: 'wx' });
    await rows("INSERT INTO license(id,store_id,app_key,license_key,status,source,issued_by,issue_reason,seats,metadata) VALUES($1,$2,$3,$4,'active','admin','matrix-fixture','synthetic credential control',2,$5::jsonb)",
      [id, f.storeId, f.storeSlug, key, JSON.stringify({ authorizationMatrix: true })]);
    await rows("INSERT INTO license_activation(id,store_id,license_id,app_key,device_id_hash,activation_token_hash,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,'2000-01-01T00:00:00Z')",
      [activationId, f.storeId, id, f.storeSlug, digest(device), hashActivationToken(token)]);
    await rows("INSERT INTO app_release(id,store_id,app_key,version,channel,platform,manifest) VALUES($1,$2,$3,$4,$5,'matrix',$6::jsonb)",
      [releaseId, f.storeId, f.storeSlug, manifest.version, channel, JSON.stringify(manifest)]);
    await rows('INSERT INTO download_artifact(id,store_id,app_release_id,artifact_key,path,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [artifactId, f.storeId, releaseId, artifactKey, path, digest(payload), payload.length]);
    return { id, activationId, releaseId, artifactId, key, token, device, artifactKey, path, channel, manifest };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;
  const appHeaders = (s: Seed) => ({ [appKeyHeaderNames()[0]!]: f.storeSlug, [deviceHeaderName()]: s.device });
  const request = (url: string, principal: MatrixPrincipal, body?: unknown): PreparedMatrixCell => ({
    url, init: { method: body === undefined ? 'GET' : 'POST', headers: { ...f.requestHeaders[principal] }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    verify() { throw new Error('license request needs explicit verifier'); },
  });
  const retained = async (s: Seed, proof: MatrixProof) => {
    proof.equal(await rows('SELECT store_id,app_key,license_key,status,seats FROM license WHERE id=$1', [s.id]),
      [{ store_id: f.storeId, app_key: f.storeSlug, license_key: s.key, status: 'active', seats: 2 }], 'real active license remains scoped to fixture store', 'state');
    proof.equal(await rows('SELECT app_release_id,path,sha256,size_bytes::int AS size_bytes FROM download_artifact WHERE id=$1', [s.artifactId]),
      [{ app_release_id: s.releaseId, path: s.path, sha256: digest(payload), size_bytes: payload.length }], 'real artifact retains seeded release & digest', 'state');
    proof.equal(await readFile(join(env.DOWNLOAD_DIR, s.path)), payload, 'private artifact bytes remain intact', 'state');
  };
  async function actionPrepared(action: Action, principal: MatrixPrincipal, named = false): Promise<PreparedMatrixCell> {
    const s = await seed();
    const url = named ? `/v1/apps/${f.storeSlug}/licenses/activate` : `/api/licenses/${action}`;
    const device = action === 'activate' ? 'fresh-device-' + randomUUID() : s.device;
    const body = action === 'activate' ? { app: f.storeSlug, licenseKey: s.key, deviceId: device }
      : { app: f.storeSlug, activationToken: s.token, ...(action === 'refresh' ? { deviceId: device } : {}) };
    return { ...request(url, principal, body), async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      if (action === 'activate') {
        proof.ok(typeof b.activationToken === 'string' && b.activationToken.startsWith('sr_act_'), 'body license capability returns fresh device activation token');
        proof.equal(b, named
          ? { activated: true, ok: true, appKey: f.storeSlug, status: 'active', licenseId: s.id, activationToken: b.activationToken, updatesUntil: null, expiresAt: null, seats: 2 }
          : { ok: true, status: 'active', licenseId: s.id, activationToken: b.activationToken, updatesUntil: null, message: 'Activated' }, 'exact activated response');
        proof.equal(await rows('SELECT store_id,app_key,device_id_hash,activation_token_hash,state FROM license_activation WHERE license_id=$1 AND device_id_hash=$2', [s.id, digest(device)]),
          [{ store_id: f.storeId, app_key: f.storeSlug, device_id_hash: digest(device), activation_token_hash: hashActivationToken(b.activationToken), state: 'active' }], 'new device seat & hashed token committed', 'state');
        proof.equal((await rows('SELECT id FROM license_activation WHERE license_id=$1', [s.id])).length, 2, 'existing seat retained alongside new seat', 'state');
      } else if (action === 'refresh') {
        proof.equal(b, { ok: true, status: 'active', licenseId: s.id, updatesUntil: null, expiresAt: null }, 'exact capability refresh response');
        const a = await rows('SELECT activation_token_hash,device_id_hash,state,last_seen_at FROM license_activation WHERE id=$1', [s.activationId]);
        proof.equal(a.map(row => ({ activation_token_hash: row.activation_token_hash, device_id_hash: row.device_id_hash, state: row.state })),
          [{ activation_token_hash: hashActivationToken(s.token), device_id_hash: digest(s.device), state: 'active' }], 'refresh keeps original bound token & device', 'state');
        proof.ok(new Date(a[0]!.last_seen_at).getTime() > Date.UTC(2000, 0, 1), 'refresh commits last-seen timestamp', 'state');
      } else {
        proof.equal(b, { ok: true }, 'exact deactivation response');
        proof.equal(await rows('SELECT id FROM license_activation WHERE id=$1', [s.activationId]), [], 'only supplied activation seat removed', 'state');
      }
      await retained(s, proof);
    } };
  }
  async function licensedRead(kind: 'updates' | 'download', existingSeed?: Seed): Promise<PreparedMatrixCell> {
    const s = existingSeed ?? await seed();
    const url = kind === 'updates' ? `/v1/apps/${f.storeSlug}/updates/latest?channel=${s.channel}&platform=matrix`
      : `/v1/apps/${f.storeSlug}/downloads/${s.artifactKey}`;
    // Distinct credentials coexist: cookie carries admin identity; Bearer carries license key.
    const headers = { ...f.requestHeaders.owner, cookie: `${SESSION_COOKIE}=${encodeURIComponent(f.identityFor('owner').token)}`, authorization: 'Bearer ' + s.key };
    const before = await f.snapshot();
    return { url, init: { headers }, async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json;
      if (kind === 'updates') proof.equal(b, { eligible: true, version: s.manifest.version, manifest: s.manifest }, 'real license receives exact seeded release manifest');
      else {
        proof.equal({ artifactKey: b.artifactKey, sha256: b.sha256, sizeBytes: b.sizeBytes },
          { artifactKey: s.artifactKey, sha256: digest(payload), sizeBytes: payload.length }, 'real license receives exact artifact metadata');
        const link = new URL(b.url, 'http://matrix.invalid');
        proof.equal(link.pathname, '/v1/dl/' + s.artifactKey, 'download URL names own artifact');
        proof.equal(link.searchParams.get('store'), f.storeId, 'signed URL binds own store');
        proof.ok(verifyDownloadSig(f.storeId, s.artifactKey, Number(link.searchParams.get('exp')), link.searchParams.get('sig') ?? ''), 'download URL carries valid short-lived signature');
        proof.equal(response.headers.get('cache-control')?.includes('no-store'), true, 'download credential is never cached');
      }
      proof.equal(await f.snapshot(), before, 'licensed metadata read leaves full domain/files/providers unchanged', 'state');
      await retained(s, proof);
    } };
  }
  return { rows, seed, appHeaders, request, retained, actionPrepared, licensedRead };
}

export function createLicenseCases(f: Fixture): MatrixCase[] {
  const src = licenseSource(f), cases: MatrixCase[] = [];
  const add = (key: string, contract: MatrixCase['contract'], build: (p: MatrixPrincipal) => MatrixCell) => {
    cases.push({ key, contract, cells: Object.fromEntries(PRINCIPALS.map(p => [p, build(p)])) as Record<MatrixPrincipal, MatrixCell> });
  };
  for (const base of bodyAliases) for (const action of activationActions) add(`POST ${base}/${action}`, 'capability', p => ({
    effect: 'allow', status: 200, async prepare() { const prepared = await src.actionPrepared(action, p); return { ...prepared, url: `${base}/${action}` }; },
  }));
  add('POST /v1/apps/{appKey}/licenses/activate', 'capability', p => ({ effect: 'allow', status: 200, prepare: () => src.actionPrepared('activate', p, true) }));
  for (const base of bodyAliases) add(`POST ${base}/trial`, 'public', p => ({ effect: 'allow', status: 200, async prepare() {
    const email = 'trial-' + randomUUID() + '@matrix.invalid', earliest = Date.now();
    return { ...src.request(`${base}/trial`, p, { app: f.storeSlug, email }), async verify(response: Response, proof: MatrixProof) {
      proof.equal(await response.json(), { ok: true, status: 'sent', message: 'Check your email for your 14-day Pro key.' }, 'public trial returns no usable license credential');
      const trial = await src.rows("SELECT l.id,l.license_key,l.status,l.source,l.issued_by,l.issue_reason,l.seats,l.updates_until,l.expires_at,l.metadata,c.email FROM license l JOIN customer c ON c.id=l.customer_id WHERE c.email=$1 AND l.app_key=$2", [email, f.storeSlug]);
      proof.equal(trial.length, 1, 'public trial commits exactly one license for fresh mailbox', 'state');
      const row = trial[0]!;
      proof.equal({ status: row.status, source: row.source, issued_by: row.issued_by, issue_reason: row.issue_reason, seats: row.seats, metadata: row.metadata, email: row.email },
        { status: 'active', source: 'admin', issued_by: 'trial-self-serve', issue_reason: '14-day self-serve Pro trial', seats: 2, metadata: { tier: 'pro', kind: 'trial' }, email }, 'trial issuance provenance & mailbox committed', 'state');
      proof.ok(typeof row.license_key === 'string' && row.license_key.length > 10, 'trial stores generated key without exposing it', 'state');
      const expires = new Date(row.expires_at).getTime();
      proof.ok(expires >= earliest + 14 * 86_400_000 && expires <= Date.now() + 14 * 86_400_000, 'trial has bounded fourteen-day hard expiry', 'state');
      proof.equal(new Date(row.updates_until).getTime(), expires, 'trial updates expire with license', 'state');
      proof.equal(await src.rows('SELECT id FROM license_activation WHERE license_id=$1', [row.id]), [], 'trial issuance alone grants no activated seat', 'state');
    } };
  } }));
  add('GET /releases/latest.json', 'capability', p => ({ effect: 'deny', status: 401, async prepare() {
    const s = await src.seed(), before = await f.snapshot();
    return { ...src.request(`/releases/latest.json?channel=${s.channel}&platform=matrix`, p),
      init: { headers: { ...f.requestHeaders[p], ...src.appHeaders(s) } }, snapshot: f.snapshot,
      async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { ok: false, message: p === 'cache_token' ? 'Missing activation token' : 'Invalid activation token' }, 'admin/service/cache identity cannot serve as activation token');
        proof.equal(await f.snapshot(), before, 'invalid feed token leaves full raw snapshot unchanged', 'state');
        await src.retained(s, proof);
      } };
  } }));
  for (const kind of ['updates', 'download'] as const) {
    const key = kind === 'updates' ? 'GET /v1/apps/{appKey}/updates/latest' : 'GET /v1/apps/{appKey}/downloads/{artifactKey}';
    let target: ReturnType<typeof src.seed> | undefined;
    const sharedSeed = () => target ??= src.seed();
    const c: MatrixCase = { key, contract: 'capability', cells: {} as Record<MatrixPrincipal, MatrixCell>, concealmentControl: async () => src.licensedRead(kind, await sharedSeed()) };
    for (const p of PRINCIPALS) c.cells[p] = { effect: 'deny', status: p === 'cache_token' ? 401 : 404,
      errorCode: p === 'cache_token' ? 'LICENSE_KEY_MISSING' : kind === 'updates' ? 'LICENSE_NOT_FOUND' : 'DOWNLOAD_NOT_FOUND',
      ...(p === 'cache_token' ? {} : { concealment: true as const }), async prepare() {
        const s = await sharedSeed();
        const url = kind === 'updates' ? `/v1/apps/${f.storeSlug}/updates/latest?channel=${s.channel}&platform=matrix` : `/v1/apps/${f.storeSlug}/downloads/${s.artifactKey}`;
        return { ...src.request(url, p), snapshot: f.snapshot, async verify(response: Response, proof: MatrixProof) {
          const b = await response.json() as Json;
          proof.equal(b.error?.code, p === 'cache_token' ? 'LICENSE_KEY_MISSING' : kind === 'updates' ? 'LICENSE_NOT_FOUND' : 'DOWNLOAD_NOT_FOUND', 'own license credential required independently of supplied admin identity');
          proof.equal(b.error?.message, p === 'cache_token' ? 'Missing license key — provide Authorization: Bearer <licenseKey>' : kind === 'updates' ? 'license not found' : 'download not found', 'exact capability concealment reason');
          await src.retained(s, proof);
        } };
      } };
    cases.push(c);
  }
  add('GET /v1/dl/{artifactKey}', 'capability', p => ({ effect: 'allow', status: 200, async prepare() {
    const s = await src.seed();
    return { ...src.request(signedDownloadPath(f.storeId, s.artifactKey), p), async verify(response: Response, proof: MatrixProof) {
      proof.equal(Buffer.from(await response.arrayBuffer()), payload, 'signed URL returns exact private artifact bytes with original principal headers');
      proof.equal(response.headers.get('content-type'), 'application/octet-stream', 'download streams binary content');
      proof.equal(response.headers.get('content-length'), String(payload.length), 'download byte length matches fixture');
      proof.equal(response.headers.get('content-disposition'), `attachment; filename="${s.artifactKey}"`, 'download disposition names artifact');
      await src.retained(s, proof);
    } };
  } }));
  for (const method of ['GET', 'POST'] as const) add(`${method} /v1/admin/apps/releases`, 'admin', p => {
    const allow = method === 'GET' ? ['owner', 'manager', 'staff', 'read_only', 'agent'].includes(p) : ['owner', 'manager', 'release_service'].includes(p);
    const status = allow ? 200 : ['release_service', 'cache_token'].includes(p) ? 401 : 403;
    return { effect: allow ? 'allow' : 'deny', status, ...(p === 'agent' && method === 'POST' ? { errorCode: 'AGENT_NOT_ALLOWED' } : {}), async prepare() {
      const s = await src.seed(), version = '2.0.0-' + randomUUID();
      const manifest = { version, notes: 'Synthetic authorized release' }, artifactKey = 'publish-' + randomUUID();
      const body = { appKey: f.storeSlug, version, channel: 'stable', platform: 'matrix', manifest,
        artifacts: [{ artifactKey, path: s.path, sha256: digest(payload), sizeBytes: payload.length }] };
      const url = '/v1/admin/apps/releases' + (method === 'GET' ? `?appKey=${f.storeSlug}&channel=${s.channel}` : '');
      return { ...src.request(url, p, method === 'POST' ? body : undefined),
        ...(allow ? {} : { snapshot: f.snapshotFor(p, method, url, status, p === 'agent' && method === 'POST' ? 'release' : undefined) }),
        async verify(response: Response, proof: MatrixProof) {
          const b = await response.json() as Json;
          if (!allow) {
            const message = p === 'foreign_store' ? `no access to store: ${f.storeSlug}` : p === 'staff' ? "role 'staff' lacks the 'releases' permission"
              : p === 'read_only' ? "role 'read_only' is read-only" : p === 'agent' ? 'agents cannot publish releases' : p === 'cache_token' ? 'not authenticated' : 'invalid or expired session';
            proof.equal(b.error?.message, message, 'exact release admin/store/service policy denial');
            proof.equal(b.error?.code, p === 'agent' ? 'AGENT_NOT_ALLOWED' : status === 401 ? 'NOT_AUTHENTICATED' : slugifyCode(message), 'exact structured release authorization code');
            return;
          }
          if (method === 'GET') {
            const release = await src.rows('SELECT published_at FROM app_release WHERE id=$1', [s.releaseId]);
            proof.equal(b, { items: [{ id: s.releaseId, appKey: f.storeSlug, version: s.manifest.version, channel: s.channel, platform: 'matrix', publishedAt: new Date(release[0]!.published_at).toISOString() }] }, 'exact own-store release listing');
          } else {
            proof.ok(typeof b.id === 'string', 'release publication returns committed identifier');
            proof.equal(await src.rows('SELECT store_id,app_key,version,channel,platform,manifest FROM app_release WHERE id=$1', [b.id]),
              [{ store_id: f.storeId, app_key: f.storeSlug, version, channel: 'stable', platform: 'matrix', manifest }], 'authorized release manifest committed in bound store', 'state');
            proof.equal(await src.rows('SELECT app_release_id,artifact_key,path,sha256,size_bytes::int AS size_bytes FROM download_artifact WHERE artifact_key=$1', [artifactKey]),
              [{ app_release_id: b.id, artifact_key: artifactKey, path: s.path, sha256: digest(payload), size_bytes: payload.length }], 'release & artifact commit together', 'state');
          }
          await src.retained(s, proof);
        } };
    } };
  });
  return cases;
}

/** Genuine capabilities & semantic negative controls are supplementary, never counted as admin grants. */
export function createLicenseCapabilityControls(f: Fixture): LicenseControl[] {
  const src = licenseSource(f), controls: LicenseControl[] = [];
  for (const kind of ['updates', 'download'] as const) controls.push({ key: `real license ${kind}`, status: 200, prepare: () => src.licensedRead(kind) });
  controls.push({ key: 'real activation feed', status: 200, async prepare() {
    const s = await src.seed();
    return { url: `/releases/latest.json?channel=${s.channel}&platform=matrix`, init: { headers: { ...f.requestHeaders.owner, ...src.appHeaders(s), cookie: `${SESSION_COOKIE}=${encodeURIComponent(f.identityFor('owner').token)}`, authorization: 'Bearer ' + s.token } },
      async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), s.manifest, 'real activation token returns exact seeded manifest');
        const activation = await src.rows('SELECT last_seen_at FROM license_activation WHERE id=$1', [s.activationId]);
        proof.ok(new Date(activation[0]!.last_seen_at).getTime() > Date.UTC(2000, 0, 1), 'feed commits activation heartbeat', 'state');
        await src.retained(s, proof);
      } };
  } });
  for (const base of bodyAliases) for (const action of activationActions) for (const principal of ['owner', 'release_service'] as const) controls.push({
    key: `${base}/${action} rejects ${principal} as body credential`, status: action === 'activate' ? 404 : 200, async prepare() {
      const s = await src.seed(), before = await f.snapshot();
      const token = f.requestHeaders[principal].authorization!.replace(/^Bearer\s+/i, '');
      const body = action === 'activate' ? { app: f.storeSlug, licenseKey: token, deviceId: 'ungranted-device' }
        : { app: f.storeSlug, activationToken: token, ...(action === 'refresh' ? { deviceId: s.device } : {}) };
      return { ...src.request(`${base}/${action}`, principal, body), async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), action === 'activate' ? { ok: false, status: 'not_found', message: 'License not found or inactive' }
          : action === 'refresh' ? { ok: false, status: 'invalid', message: 'License is no longer active' } : { ok: true }, 'admin/service token grants no body license capability (deactivate is deliberately idempotent)');
        proof.equal(await f.snapshot(), before, 'invalid body credential leaves complete raw domain/files/providers snapshot unchanged', 'state');
        proof.equal(await src.rows('SELECT id,activation_token_hash,state FROM license_activation WHERE id=$1', [s.activationId]),
          [{ id: s.activationId, activation_token_hash: hashActivationToken(s.token), state: 'active' }], 'existing real activation remains live', 'state');
      } };
    },
  });
  controls.push({ key: 'named app activation rejects admin license credential', status: 404, async prepare() {
    const s = await src.seed(), before = await f.snapshot();
    return { ...src.request(`/v1/apps/${f.storeSlug}/licenses/activate`, 'owner', { licenseKey: f.identityFor('owner').token, deviceId: s.device }),
      async verify(response: Response, proof: MatrixProof) {
        const b = await response.json() as Json;
        proof.equal(b.error?.code, 'LICENSE_NOT_FOUND', 'admin session cannot substitute named-app license key');
        proof.equal(b.error?.message, 'license not found', 'exact named-app capability rejection');
        proof.equal(await f.snapshot(), before, 'invalid named-app key leaves full raw snapshot unchanged', 'state');
        await src.retained(s, proof);
      } };
  } });
  controls.push({ key: 'real activation refresh rejects wrong device binding', status: 200, async prepare() {
    const s = await src.seed(), before = await f.snapshot();
    return { ...src.request('/v1/licenses/refresh', 'owner', { app: f.storeSlug, activationToken: s.token, deviceId: 'wrong-device-' + randomUUID() }),
      async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { ok: false, status: 'invalid', message: 'License is no longer active' }, 'real activation capability remains bound to seeded device');
        proof.equal(await f.snapshot(), before, 'wrong-device attempt cannot refresh heartbeat or change domain/files/providers', 'state');
        await src.retained(s, proof);
      } };
  } });
  controls.push({ key: 'release service cannot publish outside bound store', status: 403, async prepare() {
    const s = await src.seed(), before = await f.snapshot();
    const prepared = src.request('/v1/admin/apps/releases', 'release_service', { appKey: f.storeSlug, version: 'denied-' + randomUUID(), channel: 'stable', platform: 'matrix', manifest: s.manifest });
    return { ...prepared, init: { ...prepared.init, headers: { ...f.requestHeaders.release_service, 'x-store-slug': f.foreignStoreSlug } },
      async verify(response: Response, proof: MatrixProof) {
        const b = await response.json() as Json, message = `release service token is restricted to ${f.storeSlug}`;
        proof.equal(b.error?.code, slugifyCode(message), 'release service tenant restriction returns explicit policy code');
        proof.equal(b.error?.message, message, 'release service is bound to exactly fixture store');
        proof.equal(await f.snapshot(), before, 'cross-store service denial commits no release/artifact/domain/files/providers changes', 'state');
        await src.retained(s, proof);
      } };
  } });
  controls.push({ key: 'signed download rejects artifact signature tamper', status: 403, async prepare() {
    const s = await src.seed(), valid = new URL(signedDownloadPath(f.storeId, s.artifactKey), 'http://matrix.invalid');
    valid.searchParams.set('sig', 'invalid-matrix-signature');
    const before = await f.snapshot();
    return { ...src.request(valid.pathname + valid.search, 'owner'), snapshot: f.snapshot, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await response.json(), { error: 'invalid or expired download link' }, 'admin credentials cannot replace signed URL capability');
      proof.equal(await f.snapshot(), before, 'signature rejection leaves raw snapshot unchanged', 'state');
      await src.retained(s, proof);
    } };
  } });
  return controls;
}
