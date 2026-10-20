/** Bootstrap qualification & signed legacy/provider capabilities; isolated test harness only. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { issueSetupClaimToken } from '../auth/setup-claim.js';
import { verifyPassword } from '../auth/password.js';
import { invalidateStoreCache } from '../store-context.js';
import { legacyContactBinding } from '../routes/contact-legacy.js';
import { evaluatePromotionConditions } from '../money/coupon.js';
import type { MatrixMutationFixture } from './authorization-matrix.mutation-cases.testkit.js';
import { type MatrixApp, type MatrixCase, type MatrixCell, type MatrixPrincipal, type MatrixProof, type PreparedMatrixCell } from './authorization-matrix.testkit.js';

type Rows = { rows: Record<string, any>[] };
type Query = (sql: string, values?: unknown[]) => Promise<Rows>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sign = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('hex');
const qualified = new WeakSet<object>();
const receiptBrand: unique symbol = Symbol('real-empty-install-bootstrap');
export interface SetupBootstrapReceipt {
  readonly [receiptBrand]: true;
  readonly database: string;
  readonly adminId: string;
  readonly storeId: string;
  readonly storeSlug: string;
  readonly claimHash: string;
  readonly sessionHash: string;
}
export interface MatrixSetupFixture extends MatrixMutationFixture { request: MatrixApp['request'] }
export type SetupClaimedCell = MatrixCell & { setupClaimed: true };
export type SetupClaimedCase = MatrixCase & { bootstrapReceipt: SetupBootstrapReceipt; setupQualification: () => Promise<void>; cells: Record<MatrixPrincipal, SetupClaimedCell> };
export type SetupCapabilityCase = MatrixCase & { signatureControl: () => Promise<PreparedMatrixCell> };
let peerIndex = 0;
const peers = () => () => ({ remoteAddr: '198.19.' + Math.floor(++peerIndex / 250) + '.' + (peerIndex % 250 + 1) });
async function notFound(response: Response, proof: MatrixProof) {
  proof.equal(response.status, 404, 'setup concealment status');
  const requestId = response.headers.get('x-request-id');
  proof.ok(requestId, 'setup failure has request trace');
  proof.equal(await response.json(), { error: { code: 'NOT_FOUND', message: 'not found', requestId } }, 'exact non-enumerating setup failure');
}
const explicit = <T>(make: (p: MatrixPrincipal) => T): Record<MatrixPrincipal, T> => ({
  owner: make('owner'), manager: make('manager'), staff: make('staff'), read_only: make('read_only'),
  agent: make('agent'), foreign_store: make('foreign_store'), release_service: make('release_service'), cache_token: make('cache_token'),
});

/**
 * Run ONCE on dedicated fresh *_test DB, with real createApp, BEFORE principal enrollment.
 * Never clears admin rows or resets a shared DB. Receipt can only be produced by this live qualification.
 * Harness must retain memory rate-limit backend; full snapshot includes every persisted table/file/provider call.
 */
export async function runSetupBootstrap(options: {
  app: MatrixApp; expectedDatabase: string; ownerQuery: Query; snapshot: () => Promise<unknown>; proof: MatrixProof;
}): Promise<SetupBootstrapReceipt> {
  const { app, ownerQuery: query, snapshot } = options, peer = peers();
  const proof: MatrixProof = options.proof;
  const identity = (await query('select current_database() as database')).rows[0]!;
  assert.match(options.expectedDatabase, /_test$/, 'bootstrap qualification requires disposable test DB name');
  assert.equal(identity.database, options.expectedDatabase, 'bootstrap identity must match explicit dedicated DB');
  assert.deepEqual((await query('select id from admin_user')).rows, [], 'bootstrap requires globally empty admin table; no cleanup is performed');
  const storesBefore = (await query('select id,slug,name,config from store order by slug')).rows;
  const membershipsBefore = (await query('select admin_user_id,store_id,role from admin_user_store')).rows;
  assert.deepEqual(membershipsBefore, [], 'fresh installation has no owner memberships');
  const baseline = await snapshot();
  const status = await app.request('/v1/setup/status', undefined, peer());
  proof.equal(status.status, 200, 'genuine unclaimed installation exposes bootstrap status');
  proof.equal(await status.json(), { claimed: false }, 'unclaimed status contract');
  proof.equal(await snapshot(), baseline, 'status read makes no domain writes', 'state');

  const issuedAt = Date.now(), issued = await issueSetupClaimToken();
  proof.ok(/^[0-9a-f]{32}$/.test(issued.token), 'setup capability has 128 random bits');
  proof.ok(issued.expiresAt.getTime() >= issuedAt + 7 * 86400000 && issued.expiresAt.getTime() <= Date.now() + 7 * 86400000, 'genuine setup-link token expires in seven days');
  const claimHash = digest(issued.token);
  const stored = (await query('select token_hash,used_at,expires_at from setup_claim_token')).rows;
  proof.equal(stored.length, 1, 'single live hashed setup token', 'state');
  proof.equal({ token_hash: stored[0]!.token_hash, used_at: stored[0]!.used_at }, { token_hash: claimHash, used_at: null }, 'only setup token hash persisted', 'state');
  proof.equal(new Date(stored[0]!.expires_at).toISOString(), issued.expiresAt.toISOString(), 'issued expiry persisted exactly', 'state');
  const unique = randomUUID(), body = { token: issued.token, email: 'Bootstrap-' + unique + '@matrix.invalid', name: 'Matrix Bootstrap', password: 'Matrix-bootstrap-password-' + unique };
  const beforeBad = await snapshot();
  await notFound(await app.request('/v1/setup/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, token: randomBytes(16).toString('hex') }) }, peer()), proof);
  proof.equal(await snapshot(), beforeBad, 'invalid capability preserves all domain state & valid setup token', 'state');
  const claimed = await app.request('/v1/setup/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, peer());
  proof.equal(claimed.status, 200, 'genuine setup capability claims fresh installation');
  const response = await claimed.json() as Record<string, any>;
  proof.equal(Object.keys(response).sort(), ['csrfToken','storeSlug','token'], 'only bootstrap session & selected store are exposed');
  proof.ok(typeof response.token === 'string' && /^[0-9a-f]{64}$/.test(response.token), 'fresh 256-bit authenticated admin session');
  proof.ok(typeof response.csrfToken === 'string' && /^[0-9a-f]{32}$/.test(response.csrfToken), 'fresh CSRF secret');
  const cookie = claimed.headers.get('set-cookie') ?? '';
  proof.ok(cookie.includes('sr_admin=' + response.token + '; HttpOnly;') && cookie.includes('sr_csrf=' + response.csrfToken + ';') && cookie.includes('SameSite=Lax'), 'bootstrap sets matching session & CSRF cookies');

  const admins = (await query('select id,email,name,password_hash,is_installation_admin,kind from admin_user')).rows;
  proof.equal(admins.length, 1, 'exactly one installation administrator committed', 'state');
  const admin = admins[0]!, email = body.email.toLowerCase();
  proof.equal({ id: admin.id, email: admin.email, name: admin.name, is_installation_admin: admin.is_installation_admin, kind: admin.kind },
    { id: admin.id, email, name: body.name, is_installation_admin: true, kind: 'human' }, 'normalized human installation administrator committed', 'state');
  proof.ok(typeof admin.password_hash === 'string' && admin.password_hash.startsWith('$argon2id$') && admin.password_hash !== body.password, 'password stored as Argon2id hash', 'state');
  proof.ok(await verifyPassword(body.password, admin.password_hash), 'stored password verifies submitted bootstrap credential', 'state');
  const memberships = (await query('select admin_user_id,store_id,role from admin_user_store')).rows;
  proof.equal(memberships.length, 1, 'one first-store membership', 'state');
  const storeId = String(memberships[0]!.store_id);
  proof.equal(memberships, [{ admin_user_id: admin.id, store_id: storeId, role: 'owner' }], 'same installation administrator owns first store', 'state');
  const selected = (await query('select id,slug,name,config from store where id=$1', [storeId])).rows[0]!;
  proof.equal(response.storeSlug, selected.slug, 'session response selects committed first store');
  if (storesBefore.length) {
    proof.equal(selected.id, storesBefore[0]!.id, 'existing first unowned bootstrap store reused', 'state');
    proof.equal(selected.config, { ...(storesBefore[0]!.config ?? {}), published: false }, 'bootstrap config preserved & kept private', 'state');
    proof.equal((await query('select id from store')).rows.length, storesBefore.length, 'no redundant store created', 'state');
  } else {
    proof.ok(/^store-[0-9a-f]{8}$/.test(selected.slug), 'new placeholder store slug', 'state');
    proof.equal({ name: selected.name, config: selected.config }, { name: 'My Store', config: { published: false } }, 'new first store is private placeholder', 'state');
    proof.equal((await query('select id from store')).rows.length, 1, 'exactly one new first store', 'state');
  }
  proof.equal((await query('select token_hash from setup_claim_token where used_at is not null')).rows, [{ token_hash: claimHash }], 'setup token consumed exactly once', 'state');
  const sessionHash = digest(response.token);
  proof.equal((await query('select token_hash,admin_user_id,customer_id,store_id,api_token_id from session')).rows,
    [{ token_hash: sessionHash, admin_user_id: admin.id, customer_id: null, store_id: null, api_token_id: null }], 'returned session belongs only to new human admin', 'state');
  proof.equal((await query("select store_id,actor,entity,entity_id,action,data from audit_log where entity='installation' and action='claim'")).rows,
    [{ store_id: storeId, actor: email, entity: 'installation', entity_id: admin.id, action: 'claim', data: null }], 'claim provenance committed for authenticated mailbox', 'state');
  const me = await app.request('/v1/admin/me', { headers: { authorization: 'Bearer ' + response.token, 'x-store-slug': selected.slug } }, peer());
  proof.equal(me.status, 200, 'new session authenticates through real admin middleware');
  const principal = await me.json() as Record<string, any>;
  proof.equal({ email: principal.email, isInstallationAdmin: principal.isInstallationAdmin, kind: principal.kind, auth: principal.auth },
    { email, isInstallationAdmin: true, kind: 'human', auth: 'session' }, 'bootstrap response grants correct installation identity');
  proof.equal(principal.stores.map((s: Record<string, unknown>) => ({ storeId: s.storeId, slug: s.slug, role: s.role })), [{ storeId, slug: selected.slug, role: 'owner' }], 'session resolves exact first-store ownership');

  const afterClaim = await snapshot();
  await notFound(await app.request('/v1/setup/status', undefined, peer()), proof);
  await notFound(await app.request('/v1/setup/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, peer()), proof);
  proof.equal(await snapshot(), afterClaim, 'consumed capability cannot reclaim or mutate installation', 'state');
  proof.equal((await query('select current_database() as database')).rows[0]!.database, options.expectedDatabase, 'bootstrap remained on identity-pinned DB', 'state');
  const receipt: SetupBootstrapReceipt = Object.freeze({ [receiptBrand]: true as const, database: identity.database, adminId: String(admin.id), storeId, storeSlug: selected.slug, claimHash, sessionHash });
  qualified.add(receipt);
  return receipt;
}

/** Main eight-principal gate records claimed-install concealment only after genuine bootstrap proof above. */
export function createSetupCases(fixture: MatrixSetupFixture, receipt: SetupBootstrapReceipt): SetupClaimedCase[] {
  assert.ok(qualified.has(receipt), 'setup matrix requires same-process genuine bootstrap receipt');
  const peer = peers();
  return (['GET /v1/setup/status','POST /v1/setup/claim'] as const).map<SetupClaimedCase>(key => {
    const method = key.split(' ')[0]!, url = key.slice(method.length + 1);
    return { key, contract: 'capability', bootstrapReceipt: receipt,
      async setupQualification() {
        assert.ok(qualified.has(receipt), 'setup qualification requires same-process genuine bootstrap receipt');
        const identity = (await fixture.queryStore(fixture.storeId, 'select current_database() as database')).rows[0]!;
        assert.equal(identity.database, receipt.database, 'claimed setup cases remain on qualified fresh DB');
        const bound = (await fixture.queryStore(fixture.storeId, 'select a.id,a.is_installation_admin,a.kind,m.store_id,m.role from admin_user a join admin_user_store m on m.admin_user_id=a.id where a.id=$1 and m.store_id=$2', [receipt.adminId,receipt.storeId])).rows;
        assert.deepEqual(bound, [{id:receipt.adminId,is_installation_admin:true,kind:'human',store_id:receipt.storeId,role:'owner'}], 'qualified first administrator retains authentic store ownership');
      },
      cells: explicit<SetupClaimedCell>(principal => ({ effect: 'deny', status: 404, errorCode: 'NOT_FOUND', setupClaimed: true,
        async prepare() {
          const body = { token: randomBytes(16).toString('hex'), email: 'refused-' + randomUUID() + '@matrix.invalid', name: 'Matrix Refused Claim', password: 'Matrix-refused-password-' + randomUUID() };
          const scoped = await fixture.queryStore(fixture.storeId, 'select id from admin_user where id=$1', [receipt.adminId]);
          assert.equal(scoped.rows.length, 1, 'claimed matrix app retains qualified bootstrap administrator');
          return { url, env: peer(), init: { method, headers: { ...fixture.requestHeaders[principal], 'content-type': 'application/json' },
            ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) },
            snapshot: fixture.snapshot,
            async verify(response: Response, proof: MatrixProof) { await notFound(response, proof); },
          };
        },
      })),
    };
  });
}

export interface LegacyContactOptions { legacyContactSecret: string; legacyIssuedBefore: number }
export function createLegacyContactCases(fixture: MatrixSetupFixture, options: LegacyContactOptions): SetupCapabilityCase[] {
  assert.deepEqual(legacyContactBinding(fixture.storeId), { secret: options.legacyContactSecret, issuedBefore: options.legacyIssuedBefore }, 'harness must configure exact synthetic store-ID legacy signing binding');
  const peer = peers();
  const rows = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  let targetPromise: Promise<{ submission: { name: string; email: string; subject: string; message: string }; data: string; ts: string; signature: string; key: string; team: string }> | undefined;
  const seedTarget = async () => {
    const binding = legacyContactBinding(fixture.storeId);
    assert.deepEqual(binding, { secret: options.legacyContactSecret, issuedBefore: options.legacyIssuedBefore }, 'legacy signing binding remains enabled');
    const ts = String(Date.now());
    assert.ok(Number(ts) <= options.legacyIssuedBefore && Date.now() <= options.legacyIssuedBefore + 86400000, 'synthetic cutover horizon must cover fresh link');
    const unique = randomUUID(), submission = { name: 'Matrix Legacy', email: 'legacy-contact-' + unique + '@matrix.invalid', subject: 'Legacy matrix subject ' + unique, message: 'Synthetic pre-cutover message ' + unique };
    const data = Buffer.from(JSON.stringify(submission)).toString('base64url'), signature = sign(options.legacyContactSecret, data + ':' + ts);
    const key = 'legacy-contact:' + fixture.storeId + ':' + signature, team = 'legacy-team-' + fixture.storeSlug + '@matrix.invalid';
    return { submission, data, ts, signature, key, team };
  };
  const target = async () => {
    const t = await (targetPromise ??= seedTarget());
    assert.deepEqual(legacyContactBinding(fixture.storeId), { secret: options.legacyContactSecret, issuedBefore: options.legacyIssuedBefore }, 'exact synthetic signing binding remains configured');
    const current = (await rows('select config from store where id=$1', [fixture.storeId]))[0]!.config ?? {};
    await rows('update store set config=$2::jsonb where id=$1', [fixture.storeId, JSON.stringify({ ...current, published: true, notifications: { ...(current.notifications ?? {}), contactEmail: t.team } })]);
    invalidateStoreCache(fixture.storeSlug);
    return t;
  };
  const url = (t: Awaited<ReturnType<typeof target>>, signature: string) => '/v1/shop/contact/confirm-legacy?data=' + t.data + '&ts=' + t.ts + '&sig=' + signature;
  const headers = (principal?: MatrixPrincipal) => ({ ...(principal ? fixture.requestHeaders[principal] : { 'x-store-slug': fixture.storeSlug }) });
  const c: SetupCapabilityCase = {
    key: 'GET /v1/shop/contact/confirm-legacy', contract: 'capability', signatureQueryCredential: 'sig',
    cells: explicit<MatrixCell>(principal => ({ effect: 'deny', status: 403, async prepare() {
      const t = await target(), bad = (t.signature[0] === '0' ? '1' : '0') + t.signature.slice(1), path = url(t, bad);
      return { url: path, env: peer(), init: { headers: headers(principal) }, snapshot: fixture.snapshot,
        async verify(response: Response, proof: MatrixProof) {
          const html = await response.text();
          proof.equal(response.headers.get('cache-control'), 'no-store', 'legacy denial never cached');
          proof.equal(response.headers.get('referrer-policy'), 'no-referrer', 'legacy capability not leaked through referrers');
          proof.ok(html.includes('<title>Invalid link</title>') && html.includes('This confirmation link is invalid.'), 'valid-shaped bad HMAC rejected without delivery');
        },
      };
    } })),
    async signatureControl() {
      const t = await target(), path = url(t, t.signature);
      const deliveries = async () => ({
        contacts: await rows('select name,email,subject,message,status,delivered_at from contact_submission where email=$1', [t.submission.email]),
        markers: await rows('select id,store_id,type from processed_event where id=$1', [t.key]),
        outbox: await rows('select kind,recipient,status,attempts,dedupe_key,payload from email_outbox where dedupe_key in ($1,$2) order by kind', [t.key + ':ack',t.key + ':team']),
      });
      return { url: path, env: peer(), init: { headers: headers() }, async verify(response: Response, proof: MatrixProof) {
        const html = await response.text();
        proof.ok(html.includes('<title>Message confirmed</title>') && html.includes('Your message has been confirmed and delivered.'), 'genuine legacy HMAC authorizes delivery');
        const state = await deliveries();
        proof.equal(state.contacts.length, 1, 'one durable legacy submission', 'state');
        const contact = state.contacts[0]!;
        proof.equal({ ...contact, delivered_at: undefined }, { ...t.submission, status: 'delivered', delivered_at: undefined }, 'exact signed submission committed', 'state');
        proof.ok(contact.delivered_at instanceof Date, 'legacy submission delivery timestamp committed', 'state');
        proof.equal(state.markers, [{ id: t.key, store_id: fixture.storeId, type: 'legacy_contact_confirm' }], 'tenant-specific signed capability dedupe marker committed', 'state');
        proof.equal(state.outbox.map(({ kind,recipient,status,attempts,dedupe_key }) => ({ kind,recipient,status,attempts,dedupe_key })),
          [{ kind: 'contact_ack', recipient: t.submission.email, status: 'pending', attempts: 0, dedupe_key: t.key + ':ack' }, { kind: 'contact_team', recipient: t.team, status: 'pending', attempts: 0, dedupe_key: t.key + ':team' }], 'exact two queued messages & authenticated destinations', 'state');
        const stable = await deliveries();
        const replay = await fixture.request(path, { headers: headers() }, peer());
        proof.equal(replay.status, 200, 'legacy replay acknowledged');
        proof.ok((await replay.text()).includes('<title>Message confirmed</title>'), 'replay confirmation body');
        proof.equal(await deliveries(), stable, 'replayed signed capability cannot duplicate contact or outbox', 'state');
      } };
    },
  };
  return [c];
}

export interface MatrixSheerIdTransport {
  calls: unknown[];
  registerSheerIdVerification(input: {
    verificationId: string; customerId: string; clientId: string; clientSecret: string; accessToken: string; details: Record<string, unknown>;
  }): void;
}
export function createSheerIdWebhookCases(fixture: MatrixSetupFixture, transport: MatrixSheerIdTransport): SetupCapabilityCase[] {
  const peer = peers(), rows = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  type Target = { customerId: string; pendingId: string; endpointId: string; verificationId: string; raw: string; secret: string; clientId: string; clientSecret: string; accessToken: string; details: Record<string, unknown> };
  let pending: Promise<Target> | undefined;
  const seed = () => pending ??= (async () => {
    const customerId = randomUUID(), pendingId = randomUUID(), endpointId = randomUUID(), verificationId = 'matrix-verification-' + randomUUID(), secret = randomBytes(32).toString('hex');
    await rows("insert into customer(id,store_id,email,first_name,last_name) values ($1,$2,$3,'Matrix','Verified')", [customerId,fixture.storeId,'sheerid-' + customerId + '@matrix.invalid']);
    await rows("insert into sheerid_verification(id,store_id,customer_id,program_id,status) values ($1,$2,$3,'matrix-student','pending')", [pendingId,fixture.storeId,customerId]);
    await rows("insert into webhook_endpoint(id,store_id,url,topics,secret,enabled) values ($1,$2,$3,array['customer.verified'],$4,true)", [endpointId,fixture.storeId,'https://8.8.8.8/matrix/sheerid/' + customerId,randomBytes(24).toString('hex')]);
    return { customerId,pendingId,endpointId,verificationId,secret,raw: JSON.stringify({ verificationId }),clientId:'matrix-sheerid-client-' + customerId,clientSecret:'matrix-sheerid-secret-' + customerId,accessToken:'matrix-sheerid-access-' + customerId,
      details: { verificationId, lastResponse: { currentStep: 'success', segment: 'student' }, personInfo: { metadata: { customerId } } } };
  })();
  const configure = async () => {
    const t = await seed();
    const current = (await rows('select config from store where id=$1', [fixture.storeId]))[0]!.config ?? {};
    await rows('update store set config=$2::jsonb where id=$1', [fixture.storeId,JSON.stringify({ ...current, sheerid: { programId:'matrix-student',webhookSecret:t.secret,clientId:t.clientId,clientSecret:t.clientSecret,verificationTtlDays:30,segments:{student:{category:'student',discountPercent:15}} } })]);
    invalidateStoreCache(fixture.storeSlug);
    transport.registerSheerIdVerification(t);
    return t;
  };
  const path = '/v1/webhooks/sheerid/' + fixture.storeId;
  const headers = (t: Target, principal?: MatrixPrincipal, good = false) => ({ ...(principal ? fixture.requestHeaders[principal] : {}), 'content-type':'application/json',
    'x-sheerid-signature': sign(good ? t.secret : 'wrong-matrix-sheerid-key', t.raw) });
  const c: SetupCapabilityCase = {
    key: 'POST /v1/webhooks/sheerid/{storeId}', contract:'webhook',
    cells: explicit<MatrixCell>(principal => ({ effect:'deny',status:401,async prepare() {
      const t = await configure();
      return { url:path,env:peer(),init:{method:'POST',headers:headers(t,principal),body:t.raw},snapshot:fixture.snapshot,
        async verify(response: Response, proof: MatrixProof) { proof.equal(await response.json(),{error:'invalid signature'},'admin/service/cache identity never substitutes for SheerID HMAC'); } };
    } })),
    async signatureControl() {
      const t = await configure(), start = transport.calls.length;
      const ledger = async () => ({
        verification: await rows('select * from sheerid_verification where id=$1',[t.pendingId]),
        customer: await rows('select active_verifications,sheerid_verifications,verification_metadata from customer where id=$1',[t.customerId]),
        audit: await rows("select actor,data from audit_log where entity='customer' and entity_id=$1 and action='verification_succeeded'",[t.customerId]),
        delivery: await rows('select endpoint_id,topic,payload,status,attempts from webhook_delivery where endpoint_id=$1',[t.endpointId]),
      });
      return {url:path,env:peer(),init:{method:'POST',headers:headers(t,undefined,true),body:t.raw},async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(),{received:true,result:{outcome:'verified',customerId:t.customerId,category:'student',verificationId:t.verificationId}},'genuine SheerID signature applies authoritative verification');
        const calls = transport.calls.slice(start) as Array<{kind:string;method:string;url:string;headers?:Record<string,string>;body?:string}>;
        proof.equal(calls.length,2,'exact OAuth & verification provider calls','state');
        proof.equal({kind:calls[0]!.kind,method:calls[0]!.method,url:calls[0]!.url},{kind:'sheerid',method:'POST',url:'https://auth.sheerid.com/oauth/token'},'configured OAuth provider endpoint','state');
        proof.equal(Object.fromEntries(new URLSearchParams(calls[0]!.body)),{grant_type:'client_credentials',client_id:t.clientId,client_secret:t.clientSecret,audience:'https://services.sheerid.com/rest/'},'only synthetic SheerID OAuth credentials sent','state');
        proof.equal({kind:calls[1]!.kind,method:calls[1]!.method,url:calls[1]!.url,authorization:calls[1]!.headers?.authorization},
          {kind:'sheerid',method:'GET',url:'https://services.sheerid.com/rest/v2/verification/' + t.verificationId + '/details',authorization:'Bearer ' + t.accessToken},'authoritative details fetched with obtained access token','state');
        const state=await ledger(),v=state.verification[0]!;
        proof.equal(state.verification.length,1,'pending verification updated rather than orphaned','state');
        proof.equal({id:v.id,store_id:v.store_id,customer_id:v.customer_id,program_id:v.program_id,verification_id:v.verification_id,status:v.status,category:v.category,discount_percent:v.discount_percent,details:v.details},
          {id:t.pendingId,store_id:fixture.storeId,customer_id:t.customerId,program_id:'matrix-student',verification_id:t.verificationId,status:'success',category:'student',discount_percent:15,details:{currentStep:'success',segment:'student',subSegment:null}},'exact authoritative verification committed','state');
        proof.ok(v.expires_at instanceof Date && v.updated_at instanceof Date,'verification expiry & update timestamps committed','state');
        proof.ok(Math.abs(v.expires_at.getTime()-Date.now()-30*86400000)<60000,'configured 30-day trust lifetime','state');
        const verifiedAt=v.updated_at.toISOString(),expiresAt=v.expires_at.toISOString();
        proof.equal(state.customer,[{active_verifications:['student'],sheerid_verifications:[{programId:'matrix-student',category:'student',verificationId:t.verificationId,status:'verified',discountPercent:15,verifiedAt,expiresAt}],
          verification_metadata:{student:{discountPercent:15,expiresAt,lastVerified:verifiedAt}}}],'trusted customer read model recomputed from authenticated provider record','state');
        proof.equal(state.audit,[{actor:'sheerid:webhook',data:{verificationId:t.verificationId,segment:'student',category:'student'}}],'provider attribution preserved','state');
        proof.equal(state.delivery,[{endpoint_id:t.endpointId,topic:'customer.verified',payload:{customerId:t.customerId,category:'student',verificationId:t.verificationId},status:'pending',attempts:0}],'verification event queued transactionally without sending','state');
        const replay=await fixture.request(path,{method:'POST',headers:headers(t,undefined,true),body:t.raw},peer());
        proof.equal(replay.status,200,'valid signed duplicate acknowledged');
        proof.equal(await replay.json(),{received:true,result:{outcome:'verified',customerId:t.customerId,category:'student',verificationId:t.verificationId,reason:'duplicate delivery'}},'duplicate returns recorded authoritative outcome');
        proof.equal(await ledger(),state,'redelivery cannot issue additional trust, audit or event','state');
      }};
    },
  };
  return [c];
}

/** Invoke once after negative matrix cells; controls retain real route handler & cryptographic verification. */
export async function runSetupCapabilityControls(app: MatrixApp, cases: readonly SetupCapabilityCase[], proof: MatrixProof): Promise<void> {
  for(const c of cases) {
    const prepared=await c.signatureControl();
    const response=await app.request(prepared.url,prepared.init,prepared.env);
    proof.equal(response.status,200,'genuine capability control succeeds: '+c.key);
    await prepared.verify(response,proof);
  }
}

export interface MatrixSheerIdRevokeFixture extends MatrixSetupFixture {
  positiveControls: { grantedStaff: Record<string, string> };
}
async function prepareSheerIdRevoke(fixture: MatrixSheerIdRevokeFixture, actor: string): Promise<{
  url: string; body: { customerId: string; category: string }; verify(response: Response, proof: MatrixProof): Promise<void>;
}> {
  const rows = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  const customerId = randomUUID(), studentId = randomUUID(), militaryId = randomUUID(), pendingId = randomUUID(), licenseId = randomUUID();
  const studentVid = 'student-' + studentId, militaryVid = 'military-' + militaryId;
  const verifiedAt = new Date(Date.now() - 60000).toISOString(), expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  const entry = (category: string, verificationId: string | null, discountPercent: number) => ({
    programId: 'matrix-' + category, category, verificationId, status: 'verified', discountPercent, verifiedAt, expiresAt,
  });
  const importedStudent = entry('student', null, 10), teacher = entry('teacher', null, 12);
  const student = entry('student', studentVid, 15), military = entry('military', militaryVid, 20);
  const initialEntries = [importedStudent, teacher, student, military];
  const metadata = (entries: typeof initialEntries) => Object.fromEntries(entries.map(e => [e.category, {discountPercent:e.discountPercent,expiresAt:e.expiresAt,lastVerified:e.verifiedAt}]));
  await rows('insert into customer(id,store_id,email,sheerid_verifications,active_verifications,verification_metadata) values ($1,$2,$3,$4::jsonb,$5::text[],$6::jsonb)',
    [customerId,fixture.storeId,'revoke-' + customerId + '@matrix.invalid',JSON.stringify(initialEntries),['student','teacher','military'],JSON.stringify(metadata(initialEntries))]);
  for (const record of [{id:studentId,vid:studentVid,category:'student',discount:15},{id:militaryId,vid:militaryVid,category:'military',discount:20}]) {
    await rows("insert into sheerid_verification(id,store_id,customer_id,program_id,verification_id,category,status,discount_percent,expires_at,updated_at,details) values ($1,$2,$3,$4,$5,$6,'success',$7,$8,$9,$10::jsonb)",
      [record.id,fixture.storeId,customerId,'matrix-' + record.category,record.vid,record.category,record.discount,expiresAt,verifiedAt,JSON.stringify({matrix:record.id})]);
  }
  await rows("insert into sheerid_verification(id,store_id,customer_id,program_id,category,status,details) values ($1,$2,$3,'matrix-student','student','pending',$4::jsonb)",
    [pendingId,fixture.storeId,customerId,JSON.stringify({matrix:pendingId})]);
  await rows("insert into license(id,store_id,customer_id,app_key,license_key,status,source,issued_by,issue_reason,seats,metadata) values ($1,$2,$3,$4,$5,'active','admin','matrix-fixture','Existing independent entitlement',2,$6::jsonb)",
    [licenseId,fixture.storeId,customerId,'matrix-existing-app-' + customerId,'MATRIX-EXISTING-' + licenseId,JSON.stringify({matrix:licenseId})]);
  const verificationRows = () => rows('select * from sheerid_verification where store_id=$1 and customer_id=$2 order by id',[fixture.storeId,customerId]);
  const licenseRows = () => rows('select * from license where store_id=$1 and customer_id=$2',[fixture.storeId,customerId]);
  const beforeVerifications = await verificationRows(), beforeLicenses = await licenseRows();
  const condition = (category: string, activeVerifications: string[]) => evaluatePromotionConditions(
    [{code:'verified_customer',args:[{name:'categories',value:JSON.stringify([category])}]}], {subtotal:2500,activeVerifications});
  assert.deepEqual(condition('student',['student','teacher','military']),{valid:true},'existing student category grants real coupon eligibility');
  return {url:'/v1/admin/sheerid/revoke',body:{customerId,category:'student'},async verify(response: Response, proof: MatrixProof) {
    proof.equal(await response.json(),{revoked:1},'one successful student verification revoked');
    const after = await verificationRows(), revoked = after.find(v => v.id === studentId)!;
    const beforeStudent = beforeVerifications.find(v => v.id === studentId)!;
    proof.equal(after.length,3,'verification attempts remain retained','state');
    proof.equal({...revoked,updated_at:undefined},{...beforeStudent,status:'revoked',updated_at:undefined},'only student success status changes; provider history retained','state');
    proof.ok(revoked.updated_at instanceof Date && revoked.updated_at.getTime() >= new Date(verifiedAt).getTime(),'revocation timestamp committed','state');
    proof.equal(after.filter(v => v.id !== studentId),beforeVerifications.filter(v => v.id !== studentId),'other category & pending attempt preserved byte-for-byte','state');
    const retained = [teacher,military], active = ['teacher','military'];
    const customers=await rows('select sheerid_verifications,active_verifications,verification_metadata from customer where store_id=$1 and id=$2',[fixture.storeId,customerId]);
    proof.equal(customers,
      [{sheerid_verifications:retained,active_verifications:active,verification_metadata:metadata(retained)}],'row-managed & imported student trust removed while independent categories remain','state');
    proof.equal(condition('student',customers[0]!.active_verifications),{valid:false,reason:'requires verified status'},'revoked student no longer qualifies for actual verified_customer coupon','state');
    proof.equal(condition('teacher',customers[0]!.active_verifications),{valid:true},'imported teacher coupon eligibility retained','state');
    proof.equal(condition('military',customers[0]!.active_verifications),{valid:true},'independent verified military coupon eligibility retained','state');
    proof.equal(await licenseRows(),beforeLicenses,'existing active software license & issuance provenance preserved','state');
    proof.equal(await rows("select store_id,actor,entity,entity_id,action,data from audit_log where store_id=$1 and entity='customer' and entity_id=$2 and action='verification_revoked'",[fixture.storeId,customerId]),
      [{store_id:fixture.storeId,actor,entity:'customer',entity_id:customerId,action:'verification_revoked',data:{category:'student',rows:1}}],'revoke audit attributes authenticated operator exactly once','state');
  }};
}

/** Owner/manager or specifically granted human staff; agents hit irreversible entitlement boundary first. */
export function createSheerIdRevokeCases(fixture: MatrixSheerIdRevokeFixture): MatrixCase[] {
  const expected: Record<MatrixPrincipal,number> = {owner:200,manager:200,staff:403,read_only:403,agent:403,foreign_store:403,release_service:401,cache_token:401};
  const url='/v1/admin/sheerid/revoke';
  return [{key:'POST /v1/admin/sheerid/revoke',contract:'admin',cells:explicit<MatrixCell>(principal => {
    const status=expected[principal],allow=status===200,agent=principal==='agent';
    return {effect:allow?'allow':'deny',status,...(agent?{errorCode:'AGENT_NOT_ALLOWED'}:{}),async prepare() {
      const prepared=await prepareSheerIdRevoke(fixture,principal+'-'+fixture.storeSlug+'@matrix.invalid');
      return {url,init:{method:'POST',headers:fixture.requestHeaders[principal],body:JSON.stringify(prepared.body)},
        ...(allow?{}:{snapshot:fixture.snapshotFor(principal,'POST',url,status,agent?'entitlement':undefined)}),
        async verify(response: Response, proof: MatrixProof) {
          if(allow) return prepared.verify(response,proof);
          const body=await response.json() as {error?:{code?:string;message?:string}};
          if(status===401) {
            proof.equal(body.error?.code,'NOT_AUTHENTICATED','service/cache credentials cannot revoke customer trust');
            proof.ok(['not authenticated','invalid or expired session'].includes(body.error?.message ?? ''),'exact non-admin credential rejection');
          } else if(agent) {
            proof.equal(body.error?.code,'AGENT_NOT_ALLOWED','agent entitlement hard boundary applies before role grant');
            proof.equal(body.error?.message,'agents cannot issue, revoke or release entitlements','exact irreversible verification boundary');
          } else {
            const message=principal==='foreign_store'?'no access to store: '+fixture.storeSlug:principal==='read_only'?"role 'read_only' is read-only":"role 'staff' lacks the 'customer_verification' permission";
            const code=principal==='foreign_store'?('NO_ACCESS_TO_STORE_'+fixture.storeSlug.replace(/[^a-zA-Z0-9_]/g,'').toUpperCase()).slice(0,64):principal==='read_only'?'ROLE_READ_ONLY_IS_READONLY':'ROLE_STAFF_LACKS_THE_CUSTOMER_VERIFICATION_PERMISSION';
            proof.equal(body.error?.message,message,'exact tenant/role/customer-verification permission rejection');
            proof.equal(body.error?.code,code,'exact permission/tenant rejection code');
          }
        }};
    }};
  })}];
}

/** Harness explicitly grants customer_verification to this human staff control; ordinary staff stays denied. */
export async function assertGrantedStaffSheerIdRevoke(options: {app:MatrixApp;fixture:MatrixSheerIdRevokeFixture;proof:MatrixProof}): Promise<void> {
  const {app,fixture}=options;
  const proof: MatrixProof = options.proof;
  const prepared=await prepareSheerIdRevoke(fixture,'granted_staff-'+fixture.storeSlug+'@matrix.invalid');
  const response=await app.request(prepared.url,{method:'POST',headers:fixture.positiveControls.grantedStaff,body:JSON.stringify(prepared.body)});
  proof.equal(response.status,200,'explicitly granted human staff may revoke verification');
  await prepared.verify(response,proof);
}

