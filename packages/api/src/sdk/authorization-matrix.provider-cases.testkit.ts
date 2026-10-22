/** Configured provider authorization contracts; only synthetic transport effects escape handlers. */
import { createHash, randomUUID } from 'node:crypto';
import { createSession } from '../auth/session.js';
import { withStore } from '../db/client.js';
import { invalidateStoreCache } from '../store-context.js';
import { invalidateStoreTransport } from '../email/mailer.js';
import { encryptSecret, decryptSecret } from '../security/secret-crypto.js';
import { DEFAULT_STRIPE_EVENTS } from '../payments/stripe-webhook-provision.js';
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import type { CustomerCaseOptions } from './authorization-matrix.customer-cases.testkit.js';
import { MATRIX_PROVIDER as P, type AuthorizationTransport, type MatrixTransportCall } from './authorization-matrix.transport.testkit.js';
import { PRINCIPALS, type MatrixCase, type MatrixCell, type MatrixPrincipal, type MatrixProof } from './authorization-matrix.testkit.js';

type Fixture = Awaited<ReturnType<typeof createAuthorizationFixtures>>;
type Json = Record<string, any>;
type Access = 'manage' | 'read' | 'write';
type Prepared = { url: string; body?: unknown; verify(response: Response, proof: MatrixProof): Promise<void> };
type Spec = { key: string; access: Access; agentGroup?: 'credentials' | 'identity'; writeBeforeManage?: true; prepare(principal: MatrixPrincipal): Promise<Prepared> };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (response: Response) => response.json() as Promise<Json>;

function providerSource(fixture: Fixture, transport: AuthorizationTransport) {
  const rows = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  const config = async () => (await rows('SELECT config FROM store WHERE id=$1', [fixture.storeId]))[0]!.config as Json;
  async function patchConfig(patch: Json) {
    const current = await config();
    await rows('UPDATE store SET config=$2::jsonb WHERE id=$1', [fixture.storeId, JSON.stringify({ ...current, ...patch })]);
    invalidateStoreCache(fixture.storeSlug);
  }
  const listmonk = { url: P.listmonkUrl, apiUser: P.apiUser, apiToken: P.apiToken, listId: P.listId };
  async function smtp() {
    const current = await config();
    await patchConfig({ email: { ...(current.email ?? {}), smtp: {
      preset: 'custom', host: P.smtpHost, port: 587, secure: false, user: P.smtpUser, from: P.smtpFrom,
    } } });
    const sealed = encryptSecret(P.smtpPassword, { purpose: 'store:' + fixture.storeId + ':smtp:default:authCredential' });
    await rows("INSERT INTO store_secret(store_id,provider,mode,field,key_version,iv,ciphertext,auth_tag,last4,updated_by) VALUES($1,'smtp','default','authCredential',$2,$3,$4,$5,$6,'matrix-fixture') ON CONFLICT(store_id,provider,mode,field) DO UPDATE SET key_version=excluded.key_version,iv=excluded.iv,ciphertext=excluded.ciphertext,auth_tag=excluded.auth_tag,last4=excluded.last4,updated_by=excluded.updated_by",
      [fixture.storeId, sealed.v, sealed.iv, sealed.ct, sealed.tag, P.smtpPassword.slice(-4)]);
    invalidateStoreTransport(fixture.storeId);
  }
  async function stripe() {
    const current = await config();
    await patchConfig({ stripe: { ...(current.stripe ?? {}), mode: 'test' } });
  }
  const captured = (start: number) => transport.calls.slice(start) as MatrixTransportCall[];
  const actor = (principal: MatrixPrincipal) => fixture.identityFor(principal).email;
  const lmCall = (call: MatrixTransportCall, method: string, path: string, body: unknown, proof: MatrixProof) => {
    proof.equal({ kind: call.kind, method: call.method, url: call.url }, { kind: 'listmonk', method, url: P.listmonkUrl + path }, 'exact configured provider operation', 'state');
    proof.equal(call.headers?.authorization, 'Basic ' + Buffer.from(P.apiUser + ':' + P.apiToken).toString('base64'), 'only synthetic configured provider credential transmitted', 'state');
    proof.equal(call.body ? JSON.parse(call.body) : null, body, 'exact remote provider body', 'state');
  };
  return { rows, config, patchConfig, listmonk, smtp, stripe, captured, actor, lmCall };
}

/** Real RBAC/agent policy + configured existing fixtures; no service or auth mocks. */
export function createProviderCases(fixture: Fixture, transport: AuthorizationTransport): MatrixCase[] {
  const source = providerSource(fixture, transport), { rows, config, captured, actor, lmCall } = source;
  const specs: Spec[] = [
    { key: 'PATCH /v1/admin/marketing/config', access: 'manage', agentGroup: 'credentials', async prepare() {
      await source.patchConfig({ listmonk: { ...source.listmonk, apiToken: 'previous-synthetic-token' } });
      const before = await config(), start = transport.calls.length;
      return { url: '/v1/admin/marketing/config', body: source.listmonk, async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { ok: true, lists: 1 }, 'actual list checks admit configuration');
        proof.equal(await config(), { ...before, listmonk: { ...source.listmonk, url: P.listmonkUrl + '/' } }, 'verified provider config commits without dropping other store settings', 'state');
        const calls = captured(start);
        proof.equal(calls.length, 2, 'configuration validates collection & chosen existing list', 'state');
        lmCall(calls[0]!, 'GET', '/api/lists', null, proof);
        lmCall(calls[1]!, 'GET', '/api/lists/' + P.listId, null, proof);
      } };
    } },
    { key: 'GET /v1/admin/marketing/lists', access: 'read', async prepare() {
      await source.patchConfig({ listmonk: source.listmonk });
      const start = transport.calls.length, before = await config();
      return { url: '/v1/admin/marketing/lists', async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { lists: [{ id: P.listId, name: P.listName, subscribers: 7, type: 'public' }] }, 'exact existing configured provider list projection');
        const calls = captured(start); proof.equal(calls.length, 1, 'one configured list read', 'state');
        lmCall(calls[0]!, 'GET', '/api/lists?per_page=100', null, proof);
        proof.equal(await config(), before, 'remote list read preserves local configuration', 'state');
      } };
    } },
    { key: 'POST /v1/admin/marketing/sync', access: 'manage', async prepare(principal) {
      await source.patchConfig({ listmonk: source.listmonk });
      const unverified = randomUUID(), verified = randomUUID();
      await rows("INSERT INTO customer(id,store_id,email,first_name,last_name,email_verified) VALUES($1,$2,$3,'Verified','Synthetic',true),($4,$2,$5,'Unverified','Excluded',false)",
        [verified, fixture.storeId, verified + '@matrix.invalid', unverified, unverified + '@matrix.invalid']);
      const customers = await rows('SELECT email,first_name,last_name FROM customer WHERE store_id=$1 AND email_verified=true LIMIT 5000', [fixture.storeId]);
      const before = await rows('SELECT * FROM customer WHERE store_id=$1 ORDER BY id', [fixture.storeId]), auditBefore = await rows("SELECT id FROM audit_log WHERE store_id=$1 AND entity='marketing' AND action='listmonk_sync'", [fixture.storeId]);
      const start = transport.calls.length;
      return { url: '/v1/admin/marketing/sync', body: { listId: P.listId }, async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { synced: customers.length, failed: 0 }, 'every actual verified store customer synchronized');
        const calls = captured(start); proof.equal(calls.length, customers.length, 'one remote operation per verified customer', 'state');
        const expected = customers.map(customer => ({ email: customer.email, name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.email,
          lists: [P.listId], status: 'enabled', preconfirm_subscriptions: true })).sort((a,b) => String(a.email).localeCompare(String(b.email)));
        const bodies = calls.map(call => JSON.parse(call.body!)).sort((a: Json,b: Json) => a.email.localeCompare(b.email));
        proof.equal(bodies, expected, 'provider payload includes only actual verified store-A customers', 'state');
        for (const call of calls) lmCall(call, 'POST', '/api/subscribers', JSON.parse(call.body!), proof);
        proof.equal(await rows('SELECT * FROM customer WHERE store_id=$1 ORDER BY id', [fixture.storeId]), before, 'sync preserves local customer records', 'state');
        const newAudit = (await rows("SELECT id,actor,entity_id,data FROM audit_log WHERE store_id=$1 AND entity='marketing' AND action='listmonk_sync'", [fixture.storeId])).filter(row => !auditBefore.some(old => old.id === row.id));
        proof.equal(newAudit.map(row => ({ actor: row.actor, entity_id: row.entity_id, data: row.data })),
          [{ actor: actor(principal), entity_id: String(P.listId), data: { synced: customers.length, failed: 0 } }], 'sync audit records genuine authorized principal', 'state');
      } };
    } },
    { key: 'POST /v1/admin/marketing/campaigns', access: 'manage', async prepare() {
      await source.patchConfig({ listmonk: source.listmonk });
      const body = { name: 'Matrix campaign ' + randomUUID(), subject: 'Synthetic campaign', listId: P.listId, body: '<p>Matrix synthetic campaign.</p>' };
      const before = await config(), start = transport.calls.length;
      return { url: '/v1/admin/marketing/campaigns', body, async verify(response: Response, proof: MatrixProof) {
        const result = await json(response);
        proof.equal(Object.keys(result).sort(), ['id', 'name'], 'only public campaign fields projected');
        proof.equal(result.name, body.name, 'campaign name preserved');
        const calls = captured(start); proof.equal(calls.length, 1, 'one committed synthetic campaign operation', 'state');
        proof.equal(result.id, (calls[0]!.response as { data: { id: number } }).data.id, 'exact provider-minted campaign identity returned');
        lmCall(calls[0]!, 'POST', '/api/campaigns', { name: body.name, subject: body.subject, lists: [P.listId], type: 'regular', content_type: 'html', body: body.body }, proof);
        proof.equal(await config(), before, 'campaign creation preserves provider configuration', 'state');
      } };
    } },
    { key: 'POST /v1/admin/payments/settings/{provider}/{mode}/verify', access: 'manage', agentGroup: 'credentials', writeBeforeManage: true, async prepare(principal) {
      await source.stripe();
      const current = await config();
      // Fresh focused fixtures also exercise preservation of the legacy enabled toggle.
      if (current.payments?.stripe === undefined) await source.patchConfig({ payments: { ...(current.payments ?? {}), stripe: true } });
      const before = await config(), start = transport.calls.length;
      const oldAudits = await rows("SELECT id FROM audit_log WHERE store_id=$1 AND entity_id='stripe:test' AND action='secret_verify'", [fixture.storeId]);
      return { url: '/v1/admin/payments/settings/stripe/test/verify', async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { ok: true }, 'real Stripe SDK authenticated balance check succeeded');
        const calls = captured(start); proof.equal(calls.length, 1, 'one harmless provider verification request', 'state');
        proof.equal({ kind: calls[0]!.kind, method: calls[0]!.method, url: calls[0]!.url, body: calls[0]!.body },
          { kind: 'stripe', method: 'GET', url: 'https://api.stripe.com/v1/balance', body: '' }, 'SDK issues actual balance read', 'state');
        const after = await config(), verifiedAt = after.payments?.stripe?.test?.verifiedAt;
        proof.ok(typeof verifiedAt === 'string' && Number.isFinite(Date.parse(verifiedAt)), 'successful provider verification publishes readiness timestamp', 'state');
        const previousStripe = before.payments?.stripe;
        const preservedStripe = typeof previousStripe === 'boolean' ? { enabled: previousStripe } : { ...(previousStripe ?? {}) };
        const expected = { ...before, payments: { ...(before.payments ?? {}), stripe: { ...preservedStripe, test: { ...(before.payments?.stripe?.test ?? {}), verifiedAt } } } };
        proof.equal(after, expected, 'readiness update preserves all other store settings', 'state');
        const audits = (await rows("SELECT id,actor,data FROM audit_log WHERE store_id=$1 AND entity_id='stripe:test' AND action='secret_verify'", [fixture.storeId])).filter(row => !oldAudits.some(old => old.id === row.id));
        proof.equal(audits.map(row => ({ actor: row.actor, data: row.data })), [{ actor: actor(principal), data: { provider: 'stripe', mode: 'test', ok: true } }], 'verify audit attributes genuine human operator', 'state');
      } };
    } },
    { key: 'POST /v1/admin/payments/settings/stripe/{mode}/webhook', access: 'manage', agentGroup: 'credentials', writeBeforeManage: true, async prepare(principal) {
      await source.stripe();
      transport.freshStripeWebhooks();
      const start = transport.calls.length;
      const auditsBefore = await rows("SELECT id FROM audit_log WHERE store_id=$1 AND action='webhook_provision'", [fixture.storeId]);
      return { url: '/v1/admin/payments/settings/stripe/test/webhook', async verify(response: Response, proof: MatrixProof) {
        const result = await json(response);
        proof.ok(/^we_matrix_\d+$/.test(result.endpointId), 'provider-minted endpoint identity');
        proof.equal({ ...result, endpointId: undefined }, { endpointId: undefined, created: true, recreated: false }, 'fresh remote endpoint created once');
        const calls = captured(start); proof.equal(calls.length, 2, 'webhook list then create provider calls', 'state');
        proof.equal({ method: calls[0]!.method, url: calls[0]!.url }, { method: 'GET', url: 'https://api.stripe.com/v1/webhook_endpoints?limit=100' }, 'SDK lists existing provider endpoints', 'state');
        proof.equal({ method: calls[1]!.method, url: calls[1]!.url }, { method: 'POST', url: 'https://api.stripe.com/v1/webhook_endpoints' }, 'SDK creates real webhook endpoint request', 'state');
        const form = new URLSearchParams(calls[1]!.body);
        proof.equal(form.get('url'), 'https://shop.matrix.invalid/v1/webhooks/stripe', 'trusted configured webhook target', 'state');
        proof.equal(form.get('metadata[sellright_managed]'), fixture.storeId + ':test', 'provider endpoint explicitly bound to store & mode', 'state');
        proof.equal(DEFAULT_STRIPE_EVENTS.map((_event, index) => form.get('enabled_events[' + index + ']')), DEFAULT_STRIPE_EVENTS, 'exact managed Stripe event subscription', 'state');
        const saved = (await rows("SELECT key_version,iv,ciphertext,auth_tag,last4,metadata,updated_by FROM store_secret WHERE store_id=$1 AND provider='stripe' AND mode='test' AND field='webhookSecret'", [fixture.storeId]))[0]!;
        proof.equal(decryptSecret({ v: saved.key_version, iv: saved.iv, ct: saved.ciphertext, tag: saved.auth_tag }, 'store:' + fixture.storeId + ':stripe:test:webhookSecret'),
          P.stripeWebhookSecret, 'provider-issued signing secret encrypted for exact store purpose', 'state');
        proof.equal({ last4: saved.last4, metadata: saved.metadata, updated_by: saved.updated_by },
          { last4: P.stripeWebhookSecret.slice(-4), metadata: { webhookEndpointId: result.endpointId, url: 'https://shop.matrix.invalid/v1/webhooks/stripe' }, updated_by: actor(principal) },
          'webhook secret provenance & endpoint identity persisted', 'state');
        const audits = (await rows("SELECT id,actor,data FROM audit_log WHERE store_id=$1 AND action='webhook_provision'", [fixture.storeId])).filter(row => !auditsBefore.some(old => old.id === row.id));
        proof.equal(audits.map(row => ({ actor: row.actor, data: row.data })), [{ actor: actor(principal), data: { mode: 'test', endpointId: result.endpointId, created: true, recreated: false } }], 'webhook provisioning audit identifies actual operator', 'state');
      } };
    } },
    { key: 'POST /v1/admin/payments/settings/stripe/{mode}/payment-method-domains', access: 'manage', agentGroup: 'credentials', writeBeforeManage: true, async prepare(principal) {
      await source.stripe();
      await source.patchConfig({ storefrontUrl: 'https://shop.matrix.invalid' });
      transport.freshStripeDomains();
      const start = transport.calls.length;
      const auditsBefore = await rows("SELECT id FROM audit_log WHERE store_id=$1 AND action='payment_method_domain_register'", [fixture.storeId]);
      return { url: '/v1/admin/payments/settings/stripe/test/payment-method-domains', async verify(response: Response, proof: MatrixProof) {
        const result = await json(response);
        proof.equal(result.mode, 'test', 'registration bound to requested mode');
        proof.equal(result.domains.map((d: Json) => ({ ...d, id: undefined })), [{ domain: 'shop.matrix.invalid', id: undefined, outcome: 'created', enabled: true, applePay: 'active', googlePay: 'active' }],
          'store-owned storefront domain registered once');
        proof.ok(/^pmd_matrix_\d+$/.test(result.domains[0].id), 'provider-minted domain identity');
        const calls = captured(start); proof.equal(calls.length, 2, 'domain lookup then create provider calls', 'state');
        proof.equal({ method: calls[0]!.method, url: calls[0]!.url }, { method: 'GET', url: 'https://api.stripe.com/v1/payment_method_domains?domain_name=shop.matrix.invalid&limit=1' }, 'SDK looks up the exact domain first', 'state');
        proof.equal({ method: calls[1]!.method, url: calls[1]!.url }, { method: 'POST', url: 'https://api.stripe.com/v1/payment_method_domains' }, 'SDK creates the domain registration', 'state');
        proof.equal(Object.fromEntries(new URLSearchParams(calls[1]!.body)), { domain_name: 'shop.matrix.invalid', enabled: 'true' }, 'exact registration payload', 'state');
        const audits = (await rows("SELECT id,actor,data FROM audit_log WHERE store_id=$1 AND action='payment_method_domain_register'", [fixture.storeId])).filter(row => !auditsBefore.some(old => old.id === row.id));
        proof.equal(audits.map(row => ({ actor: row.actor, data: row.data })), [{ actor: actor(principal), data: { mode: 'test', domains: [{ domain: 'shop.matrix.invalid', outcome: 'created', applePay: 'active', googlePay: 'active' }] } }],
          'domain registration audit identifies actual operator', 'state');
      } };
    } },
    { key: 'POST /v1/admin/email/settings/test-send', access: 'write', async prepare() {
      await source.smtp();
      const before = await config(), to = 'test-' + randomUUID() + '@matrix.invalid', start = transport.calls.length;
      return { url: '/v1/admin/email/settings/test-send', body: { to }, async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { delivered: true }, 'configured actual mailer delivers through isolated SMTP adapter');
        const calls = captured(start); proof.equal(calls.length, 1, 'one actual mailer delivery', 'state');
        proof.equal(calls[0]!.kind, 'smtp', 'only SMTP transport used', 'state');
        proof.equal(calls[0]!.smtp?.message, { from: P.smtpUser, to, subject: 'SellRight test email',
          text: 'This is a test email from your SellRight store settings. If you received this, your SMTP settings work.',
          html: '<p>This is a test email from your SellRight store settings. If you received this, your SMTP settings work.</p>' }, 'exact message emitted by actual saved-settings mailer', 'state');
        const after = await config(), verifiedAt = after.email?.verifiedAt;
        proof.ok(typeof verifiedAt === 'string' && Number.isFinite(Date.parse(verifiedAt)), 'successful mail verification publishes readiness', 'state');
        proof.equal(after, { ...before, email: { ...before.email, verifiedAt } }, 'SMTP verification preserves config & records success', 'state');
      } };
    } },
    { key: 'POST /v1/admin/staff/invites', access: 'manage', agentGroup: 'identity', async prepare(principal) {
      await source.smtp();
      const email = 'invited-' + randomUUID() + '@matrix.invalid', start = transport.calls.length;
      return { url: '/v1/admin/staff/invites', body: { email, role: 'staff' }, async verify(response: Response, proof: MatrixProof) {
        const result = await json(response);
        proof.equal(Object.keys(result).sort(), ['delivered', 'id'], 'invite response never discloses mailbox capability');
        proof.equal(result.delivered, true, 'invite genuinely delivered through configured mailer');
        const calls = captured(start); proof.equal(calls.length, 1, 'one invite sent solely to invited mailbox', 'state');
        const message = calls[0]!.smtp?.message;
        proof.equal({ kind: calls[0]!.kind, to: message?.to, from: message?.from }, { kind: 'smtp', to: email, from: P.smtpFrom }, 'store SMTP sender & exact target mailbox', 'state');
        const token = /[?&]token=([a-f0-9]{64})/.exec(String(message?.html))?.[1];
        proof.ok(token, 'actual invite template contains secret mailbox capability', 'state');
        const invite = (await rows('SELECT store_id,email,role,token_hash,accepted_at,expires_at FROM staff_invite WHERE id=$1', [result.id]))[0]!;
        proof.equal({ store_id: invite.store_id, email: invite.email, role: invite.role, token_hash: invite.token_hash, accepted_at: invite.accepted_at },
          { store_id: fixture.storeId, email, role: 'staff', token_hash: digest(token), accepted_at: null }, 'real pending invitation stores hash only', 'state');
        proof.ok(invite.expires_at instanceof Date && invite.expires_at.getTime() > Date.now(), 'invite has future expiry', 'state');
        proof.equal(await rows("SELECT actor,action,data FROM audit_log WHERE store_id=$1 AND entity='staff_invite' AND entity_id=$2", [fixture.storeId, result.id]),
          [{ actor: actor(principal), action: 'create', data: { email, role: 'staff' } }], 'invite creation audit records actual authorized operator', 'state');
      } };
    } },
    { key: 'PATCH /v1/admin/settings/payments/stripe-mode', access: 'manage', agentGroup: 'credentials', async prepare(principal) {
      const current = await config(); await source.patchConfig({ stripe: { ...(current.stripe ?? {}), mode: 'live' } });
      const before = await config(), start = transport.calls.length, auditsBefore = await rows("SELECT id FROM audit_log WHERE store_id=$1 AND action='settings_update'", [fixture.storeId]);
      return { url: '/v1/admin/settings/payments/stripe-mode', body: { mode: 'test' }, async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { stripeMode: 'test' }, 'configured synthetic test credentials admit mode switch');
        proof.equal(await config(), { ...before, stripe: { ...before.stripe, mode: 'test' } }, 'Stripe mode changes only intended settings', 'state');
        proof.equal(captured(start), [], 'mode switch resolves actual credentials without network', 'state');
        const audits = (await rows("SELECT id,actor,data FROM audit_log WHERE store_id=$1 AND action='settings_update'", [fixture.storeId])).filter(row => !auditsBefore.some(old => old.id === row.id));
        proof.equal(audits.map(row => ({ actor: row.actor, data: row.data })), [{ actor: actor(principal), data: { section: 'stripe', before: { mode: 'live' }, after: { mode: 'test' } } }], 'mode switch audit records human actor without key material', 'state');
      } };
    } },
    { key: 'POST /v1/admin/seo/indexnow/submit', access: 'write', async prepare() {
      const current = await config(), key = 'a'.repeat(32), urls = ['https://shop.matrix.invalid/products/' + randomUUID()];
      await source.patchConfig({ seo: { ...(current.seo ?? {}), siteUrl: 'https://shop.matrix.invalid', indexNow: { key } } });
      const before = await config(), start = transport.calls.length;
      return { url: '/v1/admin/seo/indexnow/submit', body: { urls }, async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { ok: true, status: 202 }, 'actual IndexNow adapter receives accepted provider result');
        const calls = captured(start); proof.equal(calls.length, 1, 'one actual IndexNow submission', 'state');
        proof.equal({ kind: calls[0]!.kind, method: calls[0]!.method, url: calls[0]!.url }, { kind: 'indexnow', method: 'POST', url: 'https://api.indexnow.org/indexnow' }, 'fixed trusted provider endpoint', 'state');
        proof.equal(JSON.parse(calls[0]!.body!), { host: 'shop.matrix.invalid', key, keyLocation: 'https://shop.matrix.invalid/' + key + '.txt', urlList: urls }, 'exact synthetic store-owned URL submission', 'state');
        proof.equal(await config(), before, 'submission preserves SEO settings', 'state');
      } };
    } },
  ];
  return specs.map(spec => ({ key: spec.key, contract: 'admin' as const, cells: Object.fromEntries(PRINCIPALS.map(principal => {
    const status = principal === 'release_service' || principal === 'cache_token' ? 401
      : principal === 'foreign_store' || (principal === 'agent' && spec.agentGroup)
        || (spec.access === 'manage' && !['owner', 'manager'].includes(principal)) || (spec.access === 'write' && principal === 'read_only') ? 403 : 200;
    const allowed = status === 200, method = spec.key.split(' ')[0]!;
    const group = principal === 'agent' ? spec.agentGroup : undefined;
    const cell: MatrixCell = { effect: allowed ? 'allow' : 'deny', status,
      ...(group ? { errorCode: 'AGENT_NOT_ALLOWED' } : {}),
      async prepare() {
        const prepared = await spec.prepare(principal);
        return { url: prepared.url, init: { method, headers: fixture.requestHeaders[principal],
          ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }) },
          ...(allowed ? {} : { snapshot: fixture.snapshotFor(principal, method, prepared.url, status, group) }),
          async verify(response: Response, proof: MatrixProof) {
            if (allowed) return prepared.verify(response, proof);
            const body = await json(response);
            if (status === 401) {
              proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'service/cache credential cannot authorize admin');
              proof.ok(['not authenticated', 'invalid or expired session'].includes(body.error?.message), 'actual credential rejection');
            } else if (group) {
              proof.equal(body.error?.code, 'AGENT_NOT_ALLOWED', 'hard agent boundary wins over assigned role');
              proof.equal(body.error?.message, group === 'identity' ? 'agents cannot manage staff or agents' : 'agents cannot change credentials or payment/e-mail secrets', 'exact hard boundary reason');
            } else {
              proof.equal(body.error?.message, principal === 'foreign_store' ? 'no access to store: ' + fixture.storeSlug
                : principal === 'read_only' && spec.writeBeforeManage ? "role 'read_only' is read-only"
                : spec.access === 'manage' ? "role '" + (principal === 'agent' ? 'staff' : principal) + "' cannot manage settings/staff" : "role 'read_only' is read-only", 'exact selected-store RBAC refusal');
            }
          } };
      } };
    return [principal, cell];
  })) as Record<MatrixPrincipal, MatrixCell> }));
}

/** Shared customer lane uses configured Stripe transport without duplicating its eight denial cells. */
export function createProviderBillingPortal(fixture: Fixture, transport: AuthorizationTransport): NonNullable<CustomerCaseOptions['billingPortal']> {
  const source = providerSource(fixture, transport);
  return { async prepare() {
    await source.stripe();
    const customerId = randomUUID(), stripeId = 'cus_matrix_' + randomUUID().replaceAll('-', '');
    await source.rows('INSERT INTO customer(id,store_id,email,email_verified) VALUES($1,$2,$3,true)', [customerId, fixture.storeId, customerId + '@matrix.invalid']);
    const session = await withStore(fixture.storeId, tx => createSession(tx, fixture.storeId, customerId));
    await source.rows("INSERT INTO subscription(store_id,customer_id,stripe_subscription_id,stripe_customer_id,status) VALUES($1,$2,$3,$4,'active')",
      [fixture.storeId, customerId, 'sub_matrix_' + randomUUID(), stripeId]);
    const before = await source.rows('SELECT * FROM subscription WHERE store_id=$1 AND customer_id=$2', [fixture.storeId, customerId]), start = transport.calls.length;
    return { customerId, headers: { authorization: 'Bearer ' + session, 'x-store-slug': fixture.storeSlug, 'content-type': 'application/json' },
      expectedUrl: P.portalUrl, async assertCommitted(proof) {
        const calls = source.captured(start); proof.equal(calls.length, 1, 'one customer billing portal provider operation', 'state');
        proof.equal({ kind: calls[0]!.kind, method: calls[0]!.method, url: calls[0]!.url }, { kind: 'stripe', method: 'POST', url: 'https://api.stripe.com/v1/billing_portal/sessions' }, 'actual Stripe SDK customer portal operation', 'state');
        const form = new URLSearchParams(calls[0]!.body);
        proof.equal(Object.fromEntries(form), { customer: stripeId, return_url: 'https://shop.matrix.invalid/account/subscriptions' }, 'only authenticated customer subscription opens portal', 'state');
        proof.equal(await source.rows('SELECT * FROM subscription WHERE store_id=$1 AND customer_id=$2', [fixture.storeId, customerId]), before, 'portal creation preserves local subscription', 'state');
      } };
  } };
}

