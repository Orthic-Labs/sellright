/** Public customer authentication & mailbox capabilities; source-only B2.8 fixtures. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAdminSession } from '../auth/admin-session.js';
import { createSession } from '../auth/session.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { withStore } from '../db/client.js';
import { invalidateStoreCache } from '../store-context.js';
import { customerLoginAssertion, enrolCustomerPasskey, withCookie } from './authorization-matrix.passkey.testkit.js';
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import { PRINCIPALS, type MatrixCase, type MatrixCell, type MatrixPrincipal, type MatrixProof, type PreparedMatrixCell } from './authorization-matrix.testkit.js';

type Fixture = Awaited<ReturnType<typeof createAuthorizationFixtures>>;
type Json = Record<string, any>;
type Seed = { id: string; email: string; password: string; passwordHash: string; headers: Record<string, string>; sessionHashes: string[] };
export interface PublicAuthControl { key: string; status: number; prepare(): Promise<PreparedMatrixCell> }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const ok = async (response: Response, proof: MatrixProof) => proof.equal(await response.json(), { ok: true }, 'exact public success envelope');
async function error(response: Response, proof: MatrixProof, code: string, message: string) {
  const requestId = response.headers.get('x-request-id');
  proof.ok(requestId, 'error response carries trace identity');
  proof.equal(await response.json(), { error: { code, message, requestId } }, 'exact error envelope & matching request trace');
}

/** No admin resolution: supplied headers remain admin/service/cache credentials on public routes. */
function publicSource(fixture: Fixture) {
  const rows = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  let peerId = 0;
  // Independent synthetic transport peers avoid turning successful public cells into throttle probes.
  const peer = () => ({ remoteAddr: '198.18.' + Math.floor(++peerId / 250) + '.' + (peerId % 250 + 1) });
  const headers = (principal: MatrixPrincipal) => ({ ...fixture.requestHeaders[principal] });
  const post = (url: string, body: unknown, supplied: Record<string, string>) =>
    fixture.request(url, { method: 'POST', headers: supplied, body: JSON.stringify(body) }, peer());
  async function seed(verified = true): Promise<Seed> {
    const id = randomUUID(), email = 'public-auth-' + id + '@matrix.invalid';
    const password = 'Matrix-public-password-' + randomUUID(), passwordHash = await hashPassword(password);
    await rows("INSERT INTO customer(id,store_id,email,password_hash,first_name,last_name,email_verified) VALUES($1,$2,$3,$4,'Matrix','Public',$5)",
      [id, fixture.storeId, email, passwordHash, verified]);
    const tokens = await withStore(fixture.storeId, async tx => [
      await createSession(tx, fixture.storeId, id), await createSession(tx, fixture.storeId, id),
    ]);
    return { id, email, password, passwordHash, headers: { 'x-store-slug': fixture.storeSlug,
      'content-type': 'application/json', authorization: 'Bearer ' + tokens[0] }, sessionHashes: tokens.map(digest).sort() };
  }
  async function enableMagicLink() {
    await rows("UPDATE store SET config=jsonb_set(coalesce(config,'{}'::jsonb),'{auth}',coalesce(config->'auth','{}'::jsonb)||'{\"magicLink\":true}'::jsonb) WHERE id=$1", [fixture.storeId]);
    invalidateStoreCache(fixture.storeSlug);
  }
  async function mailToken(s: Pick<Seed, 'id' | 'email'>, kind: string, recipient = s.email) {
    const mails = await rows('SELECT kind,recipient,payload,status,attempts FROM email_outbox WHERE recipient=$1 AND store_id=$2 ORDER BY id', [recipient, fixture.storeId]);
    assert.equal(mails.length, 1, 'fixture issuance must commit exactly one real outbox message');
    assert.equal(mails[0]!.recipient, recipient);
    assert.equal(mails[0]!.kind, kind);
    assert.equal(mails[0]!.status, 'pending');
    assert.equal(mails[0]!.attempts, 0);
    const raw = /[?&]token=([A-Za-z0-9_-]+)/.exec(JSON.stringify(mails[0]!.payload))?.[1];
    assert.ok(raw, 'real outbox must contain an opaque token URL');
    const tokens = await rows('SELECT id,customer_id,kind,token_hash,used_at,expires_at,payload FROM customer_token WHERE customer_id=$1 AND kind=$2 AND token_hash=$3', [s.id, kind, digest(raw)]);
    assert.equal(tokens.length, 1, 'outbox capability must match persisted token hash');
    assert.equal(tokens[0]!.used_at, null);
    assert.ok(tokens[0]!.expires_at instanceof Date && tokens[0]!.expires_at.getTime() > Date.now());
    return { raw, row: tokens[0]!, mail: mails[0]! };
  }
  async function issue(s: Seed, kind: 'password_reset' | 'email_verify' | 'magic_link' | 'email_change') {
    if (kind === 'magic_link') await enableMagicLink();
    const newEmail = 'new-' + s.id + '@matrix.invalid';
    const path = kind === 'password_reset' ? 'forgot-password' : kind === 'email_verify' ? 'resend-verification'
      : kind === 'magic_link' ? 'magic-link/request' : 'request-email-change';
    const body = kind === 'email_change' ? { newEmail, password: s.password } : { email: s.email };
    const response = await post('/v1/shop/auth/' + path, body, kind === 'email_change' ? s.headers : { 'x-store-slug': fixture.storeSlug, 'content-type': 'application/json' });
    assert.equal(response.status, 200, 'real public token issuance prerequisite');
    assert.deepEqual(await response.json(), { ok: true });
    return { ...await mailToken(s, kind, kind === 'email_change' ? newEmail : s.email), newEmail };
  }
  async function sessionResponse(response: Response, proof: MatrixProof, s: Pick<Seed, 'id' | 'email'>, verified: boolean, existing: string[], migrated = false) {
    const body = await response.json() as Json;
    proof.equal(Object.keys(body).sort(), ['customer', 'token'], 'only customer session response fields');
    proof.equal(body.customer, { id: s.id, email: s.email, firstName: 'Matrix', lastName: 'Public', phone: null, emailVerified: verified, isMigrated: migrated },
      'body credentials/capability select fresh real customer, never supplied admin principal');
    proof.ok(typeof body.token === 'string' && body.token.length > 20, 'fresh opaque customer session');
    const hash = digest(body.token);
    proof.ok(!existing.includes(hash), 'new session differs from prior customer sessions');
    proof.equal(await rows('SELECT store_id,customer_id,admin_user_id FROM session WHERE token_hash=$1', [hash]),
      [{ store_id: fixture.storeId, customer_id: s.id, admin_user_id: null }], 'returned session persists as customer-only identity', 'state');
    proof.equal((await rows('SELECT token_hash FROM session WHERE customer_id=$1 ORDER BY token_hash', [s.id])).map(row => row.token_hash),
      [...existing, hash].sort(), 'exact customer session set after sign-in', 'state');
    const cookie = response.headers.get('set-cookie') ?? '';
    proof.ok(cookie.includes('sr_cust=' + body.token + '; HttpOnly;') && cookie.includes('Secure') && cookie.includes('sr_cust_csrf='), 'production customer cookies bind returned session & CSRF secret');
  }
  async function consumed(id: string, proof: MatrixProof) {
    const token = (await rows('SELECT used_at FROM customer_token WHERE id=$1', [id]))[0]!;
    proof.ok(token.used_at instanceof Date, 'real issued capability marked consumed', 'state');
  }
  return { rows, peer, headers, post, seed, enableMagicLink, mailToken, issue, sessionResponse, consumed };
}

export function createPublicAuthCases(fixture: Fixture): MatrixCase[] {
  const source = publicSource(fixture), { rows, peer, headers, seed, issue, sessionResponse, consumed } = source;
  type Spec = { key: string; contract: 'public' | 'capability'; prepare(principal: MatrixPrincipal): Promise<PreparedMatrixCell> };
  const request = (url: string, principal: MatrixPrincipal, body: unknown, verify: PreparedMatrixCell['verify']): PreparedMatrixCell =>
    ({ url, env: peer(), init: { method: 'POST', headers: headers(principal), body: JSON.stringify(body) }, verify });
  const specs: Spec[] = [
    { key: 'POST /v1/shop/auth/login', contract: 'public', async prepare(principal) {
      const s = await seed();
      return request('/v1/shop/auth/login', principal, { email: s.email, password: s.password }, async (response: Response, proof: MatrixProof) => {
        await sessionResponse(response, proof, s, true, s.sessionHashes);
        proof.equal((await rows('SELECT password_hash FROM customer WHERE id=$1', [s.id]))[0]!.password_hash, s.passwordHash, 'current password hash preserved', 'state');
      });
    } },
    { key: 'POST /v1/shop/auth/register', contract: 'public', async prepare(principal) {
      const email = 'registered-' + randomUUID() + '@matrix.invalid', password = 'Registered-password-' + randomUUID();
      return request('/v1/shop/auth/register', principal, { email, password, firstName: 'Matrix', lastName: 'Public' }, async (response: Response, proof: MatrixProof) => {
        const body = await response.clone().json() as Json;
        proof.ok(typeof body.customer?.id === 'string', 'registration assigns new customer identity');
        await sessionResponse(response, proof, { id: body.customer.id, email }, false, []);
        const saved = (await rows('SELECT password_hash,email_verified FROM customer WHERE id=$1 AND email=$2', [body.customer.id, email]))[0]!;
        proof.equal(saved.email_verified, false, 'registration does not claim mailbox verification', 'state');
        proof.equal(await verifyPassword(password, saved.password_hash), true, 'persisted customer password verifies actual supplied body', 'state');
        const capability = await source.mailToken({ id: body.customer.id, email }, 'email_verify');
        proof.equal(capability.row.customer_id, body.customer.id, 'registration verification outbox token belongs to new customer', 'state');
      });
    } },
    ...(['forgot-password', 'resend-verification', 'magic-link/request'] as const).map(path => ({
      key: 'POST /v1/shop/auth/' + path, contract: 'public' as const, async prepare(principal: MatrixPrincipal) {
        const s = await seed(path !== 'resend-verification');
        if (path === 'magic-link/request') await source.enableMagicLink();
        const kind = path === 'forgot-password' ? 'password_reset' : path === 'resend-verification' ? 'email_verify' : 'magic_link';
        return request('/v1/shop/auth/' + path, principal, { email: s.email }, async (response: Response, proof: MatrixProof) => {
          await ok(response, proof);
          const capability = await source.mailToken(s, kind);
          proof.equal(capability.row.customer_id, s.id, 'mailbox request mints capability for intended real customer', 'state');
          proof.equal(capability.row.kind, kind, 'correct capability kind persisted', 'state');
          proof.equal(await rows('SELECT password_hash,email,email_verified FROM customer WHERE id=$1', [s.id]),
            [{ password_hash: s.passwordHash, email: s.email, email_verified: path !== 'resend-verification' }], 'mail request preserves account credential & verification state', 'state');
          proof.equal((await rows('SELECT token_hash FROM session WHERE customer_id=$1 ORDER BY token_hash', [s.id])).map(row => row.token_hash),
            s.sessionHashes, 'mail issuance does not authenticate/revoke customer sessions', 'state');
        });
      },
    })),
    // ── passkeys (0108) ──
    { key: 'POST /v1/shop/auth/passkey/login/options', contract: 'public', async prepare(principal) {
      return request('/v1/shop/auth/passkey/login/options', principal, {}, async (response: Response, proof: MatrixProof) => {
        const body = await response.json() as Json;
        proof.ok(typeof body.options?.challenge === 'string' && body.options.userVerification === 'required' && body.options.allowCredentials?.length === 0, 'discoverable options, identical for every caller');
        proof.ok(/sr_pk_nonce=/.test(response.headers.get('set-cookie') ?? ''), 'browser-binding nonce cookie set');
        proof.equal(await rows('SELECT kind, customer_id FROM customer_passkey_challenge WHERE challenge_hash=$1', [digest(body.options.challenge)]), [{ kind: 'login', customer_id: null }], 'unbound store-scoped login challenge row', 'state');
      });
    } },
    { key: 'POST /v1/shop/auth/passkey/login/verify', contract: 'public', async prepare(principal) {
      const s = await seed();
      const { id: credentialId, auth } = await enrolCustomerPasskey(fixture.request, s.headers, s.password, fixture.storeId, s.id);
      const assertion = await customerLoginAssertion(fixture.request, auth, fixture.storeSlug, fixture.storeId, s.id, 1);
      return { url: '/v1/shop/auth/passkey/login/verify', env: peer(), init: { method: 'POST', headers: withCookie(headers(principal), assertion.cookie), body: JSON.stringify({ response: assertion.response }) },
        async verify(response: Response, proof: MatrixProof) {
          await sessionResponse(response, proof, s, true, s.sessionHashes);
          proof.equal(await rows('SELECT counter::int AS counter FROM customer_passkey_credential WHERE id=$1', [credentialId]), [{ counter: 1 }], 'credential counter advanced by the accepted assertion', 'state');
        } };
    } },
    { key: 'POST /v1/shop/auth/reset-password', contract: 'capability', async prepare(principal) {
      const s = await seed(), capability = await issue(s, 'password_reset'), next = 'Reset-password-' + randomUUID();
      return request('/v1/shop/auth/reset-password', principal, { token: capability.raw, password: next }, async (response: Response, proof: MatrixProof) => {
        await ok(response, proof); await consumed(capability.row.id, proof);
        const hash = (await rows('SELECT password_hash FROM customer WHERE id=$1', [s.id]))[0]!.password_hash;
        proof.equal(await verifyPassword(next, hash), true, 'capability authorizes committed new password', 'state');
        proof.equal(await verifyPassword(s.password, hash), false, 'old password no longer authenticates', 'state');
        proof.equal(await rows('SELECT id FROM session WHERE customer_id=$1', [s.id]), [], 'password recovery revokes all target sessions', 'state');
      });
    } },
    { key: 'POST /v1/shop/auth/verify-email', contract: 'capability', async prepare(principal) {
      const s = await seed(false), capability = await issue(s, 'email_verify');
      return request('/v1/shop/auth/verify-email', principal, { token: capability.raw }, async (response: Response, proof: MatrixProof) => {
        await ok(response, proof); await consumed(capability.row.id, proof);
        proof.equal(await rows('SELECT email,email_verified,password_hash FROM customer WHERE id=$1', [s.id]),
          [{ email: s.email, email_verified: true, password_hash: s.passwordHash }], 'capability verifies only intended mailbox & preserves password', 'state');
      });
    } },
    { key: 'POST /v1/shop/auth/verify-email-change', contract: 'capability', async prepare(principal) {
      const s = await seed(), capability = await issue(s, 'email_change');
      return request('/v1/shop/auth/verify-email-change', principal, { token: capability.raw }, async (response: Response, proof: MatrixProof) => {
        await ok(response, proof); await consumed(capability.row.id, proof);
        proof.equal(await rows('SELECT email,email_verified,password_hash FROM customer WHERE id=$1', [s.id]),
          [{ email: capability.newEmail, email_verified: true, password_hash: s.passwordHash }], 'issued capability changes exact customer identifier', 'state');
        proof.equal(await rows('SELECT id FROM session WHERE customer_id=$1', [s.id]), [], 'identifier change revokes all target sessions', 'state');
        proof.equal(await rows("SELECT actor,action,data FROM audit_log WHERE entity='customer' AND entity_id=$1 AND action='email_changed'", [s.id]),
          [{ actor: 'customer:' + s.id, action: 'email_changed', data: { email: capability.newEmail, previousEmail: s.email } }], 'provenance attributes capability customer, never admin/service identity', 'state');
        const notice = await rows('SELECT recipient,payload FROM email_outbox WHERE recipient=$1', [s.email]);
        proof.equal(notice.length, 1, 'identifier change commits one old-mailbox security notice', 'state');
        proof.equal(notice[0]!.recipient, s.email, 'notice addresses prior mailbox', 'state');
      });
    } },
    { key: 'POST /v1/shop/auth/magic-link/consume', contract: 'capability', async prepare(principal) {
      const s = await seed(false), capability = await issue(s, 'magic_link');
      return request('/v1/shop/auth/magic-link/consume', principal, { token: capability.raw }, async (response: Response, proof: MatrixProof) => {
        await sessionResponse(response, proof, s, true, s.sessionHashes); await consumed(capability.row.id, proof);
        proof.equal((await rows('SELECT email_verified FROM customer WHERE id=$1', [s.id]))[0]!.email_verified, true,
          'consumed mailbox capability verifies customer', 'state');
      });
    } },
    { key: 'GET /v1/shop/auth/check-email', contract: 'public', async prepare(principal) {
      const s = await seed(), before = await rows('SELECT * FROM customer WHERE id=$1', [s.id]);
      return { url: '/v1/shop/auth/check-email?email=' + encodeURIComponent(s.email), env: peer(), init: { headers: headers(principal) }, async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { exists: true, needsPasswordSetup: false }, 'real existing native customer existence projection');
        proof.equal(await rows('SELECT * FROM customer WHERE id=$1', [s.id]), before, 'probe preserves target customer', 'state');
      } };
    } },
    { key: 'POST /v1/shop/newsletter-signup', contract: 'public', async prepare(principal) {
      const email = 'newsletter-' + randomUUID() + '@matrix.invalid';
      return request('/v1/shop/newsletter-signup', principal, { email, name: 'Matrix Subscriber' }, async (response: Response, proof: MatrixProof) => {
        await ok(response, proof);
        const subscribers = await rows('SELECT email,name,kind,topic,status,source,token,last_sent_at FROM subscriber WHERE email=$1', [email]);
        proof.equal(subscribers.length, 1, 'exactly one real pending subscriber', 'state');
        const row = subscribers[0]!;
        proof.equal({ email: row.email, name: row.name, kind: row.kind, topic: row.topic, status: row.status, source: row.source },
          { email, name: 'Matrix Subscriber', kind: 'newsletter', topic: '', status: 'pending', source: 'storefront' }, 'signup persists explicit consent provenance', 'state');
        const mails = await rows('SELECT recipient,payload,status FROM email_outbox WHERE recipient=$1', [email]);
        proof.equal(mails.length, 1, 'subscriber confirmation committed in outbox', 'state');
        proof.equal(mails[0]!.status, 'pending', 'external mail delivery remains queued', 'state');
        proof.ok(JSON.stringify(mails[0]!.payload).includes('/v1/shop/subscriber/confirm/' + row.token), 'outbox contains exact row capability', 'state');
      });
    } },
    ...(['GET confirm', 'GET unsubscribe', 'POST unsubscribe'] as const).map(operation => {
      const [method, action] = operation.split(' ');
      return { key: method + ' /v1/shop/subscriber/' + action + '/{token}', contract: 'capability' as const,
        async prepare(principal: MatrixPrincipal) {
          const email = 'subscriber-' + randomUUID() + '@matrix.invalid';
          const issued = await source.post('/v1/shop/newsletter-signup', { email }, { 'x-store-slug': fixture.storeSlug, 'content-type': 'application/json' });
          assert.equal(issued.status, 200, 'real subscriber capability issuance');
          assert.deepEqual(await issued.json(), { ok: true });
          const subscriber = (await rows('SELECT id,token FROM subscriber WHERE email=$1', [email]))[0]!;
          assert.ok(subscriber, 'newsletter issuance persists actual subscriber');
          const id = subscriber.id as string, token = subscriber.token as string;
          const before = await rows('SELECT * FROM subscriber WHERE id=$1', [id]);
          const beforeMail = await rows('SELECT * FROM email_outbox WHERE recipient=$1 ORDER BY id', [email]);
          assert.equal(beforeMail.length, 1);
          assert.ok(JSON.stringify(beforeMail[0]!.payload).includes('/v1/shop/subscriber/confirm/' + token));
          return { url: '/v1/shop/subscriber/' + action + '/' + token, env: peer(), init: { method, headers: headers(principal) }, async verify(response: Response, proof: MatrixProof) {
            const html = await response.text();
            proof.ok((response.headers.get('content-type') ?? '').includes('text/html'), 'subscriber capability returns HTML');
            const saved = (await rows('SELECT status,confirmed_at,unsubscribed_at FROM subscriber WHERE id=$1', [id]))[0]!;
            if (method === 'GET' && action === 'unsubscribe') {
              proof.ok(html.includes('<title>Manage your subscription</title>') && html.includes('<form method="post" action="">'), 'scanner-safe explicit unsubscribe form');
              proof.equal(await rows('SELECT * FROM subscriber WHERE id=$1', [id]), before, 'landing page preserves consent', 'state');
            } else if (action === 'confirm') {
              proof.ok(html.includes('<title>Subscription confirmed</title>') && html.includes("Thanks — you're confirmed on"), 'valid capability confirms existing subscription');
              proof.equal(saved.status, 'confirmed', 'pending subscriber transitions to confirmed', 'state');
              proof.ok(saved.confirmed_at instanceof Date && saved.unsubscribed_at === null, 'confirmation timestamp commits', 'state');
            } else {
              proof.ok(html.includes('<title>Unsubscribed</title>') && html.includes('You have been unsubscribed.'), 'one-click confirmation body');
              proof.equal(saved.status, 'unsubscribed', 'valid capability revokes pending consent', 'state');
              proof.ok(saved.unsubscribed_at instanceof Date && saved.confirmed_at === null, 'unsubscribe timestamp commits', 'state');
            }
            proof.equal(await rows('SELECT * FROM email_outbox WHERE recipient=$1 ORDER BY id', [email]), beforeMail, 'subscriber capability transitions preserve issued confirmation without extra sends', 'state');
          } };
        } };
    }),
    { key: 'POST /v1/shop/contact', contract: 'public', async prepare(principal) {
      const email = 'contact-' + randomUUID() + '@matrix.invalid';
      const body = { name: 'Matrix Contact', email, subject: 'Matrix authorization question', message: 'Synthetic customer contact message.' };
      return request('/v1/shop/contact', principal, body, async (response: Response, proof: MatrixProof) => {
        proof.equal(await response.json(), { ok: true, message: 'Check your email to confirm your submission.' }, 'real submit queues confirmation');
        const saved = await rows('SELECT id,name,email,subject,message,status,delivered_at FROM contact_submission WHERE email=$1', [email]);
        proof.equal(saved.length, 1, 'exactly one persisted contact submission', 'state');
        proof.equal({ ...saved[0]!, id: undefined }, { id: undefined, ...body, status: 'pending', delivered_at: null }, 'public submit preserves pending confirmation boundary', 'state');
        const mails = await rows('SELECT kind,payload FROM email_outbox WHERE recipient=$1', [email]);
        proof.equal(mails.length, 1, 'one confirmation mail queued', 'state');
        proof.equal(mails[0]!.kind, 'contact_confirm', 'contact confirmation kind', 'state');
        proof.ok(JSON.stringify(mails[0]!.payload).includes('id=' + saved[0]!.id), 'signed link names actual pending submission', 'state');
      });
    } },
    { key: 'GET /v1/shop/contact/confirm', contract: 'capability', async prepare(principal) {
      const email = 'contact-confirm-' + randomUUID() + '@matrix.invalid';
      const body = { name: 'Matrix Contact', email, subject: 'Matrix confirm question ' + randomUUID(), message: 'Synthetic signed contact message.' };
      const submitted = await source.post('/v1/shop/contact', body, { 'x-store-slug': fixture.storeSlug, 'content-type': 'application/json' });
      assert.equal(submitted.status, 200, 'real contact capability issuance');
      const saved = (await rows('SELECT id FROM contact_submission WHERE email=$1', [email]))[0]!;
      const mails = await rows('SELECT payload FROM email_outbox WHERE recipient=$1', [email]);
      assert.equal(mails.length, 1);
      // Rendered text escapes entities & annotates anchors; decode only the URL's HTML ampersands.
      const raw = /href="([^"]*\/v1\/shop\/contact\/confirm\?[^"]+)"/.exec(String(mails[0]!.payload.html ?? ''))?.[1]?.replaceAll('&amp;', '&');
      assert.ok(raw, 'real contact outbox contains signed URL');
      const link = new URL(raw);
      assert.equal(link.searchParams.get('id'), saved.id);
      return { url: link.pathname + link.search, env: peer(), init: { headers: headers(principal) }, async verify(response: Response, proof: MatrixProof) {
        const html = await response.text();
        proof.ok(html.includes('<title>Message confirmed</title>') && html.includes('Your message has been confirmed and delivered.'), 'signed capability delivers existing contact');
        const current = (await rows('SELECT status,delivered_at FROM contact_submission WHERE id=$1', [saved.id]))[0]!;
        proof.equal(current.status, 'delivered', 'pending submission transitions to delivered', 'state');
        proof.ok(current.delivered_at instanceof Date, 'delivery timestamp committed', 'state');
        const delivery = await rows("SELECT kind,recipient,payload FROM email_outbox WHERE kind IN ('contact_team','contact_ack') AND payload::text LIKE $1", ['%' + body.subject + '%']);
        proof.equal(delivery.map(row => row.kind).sort(), ['contact_ack', 'contact_team'], 'signed confirmation atomically queues team & acknowledgment', 'state');
        proof.equal(delivery.find(row => row.kind === 'contact_ack')!.recipient, email, 'acknowledgment addresses actual submitting mailbox', 'state');
      } };
    } },
  ];
  const cases: MatrixCase[] = specs.map(spec => ({ key: spec.key, contract: spec.contract,
    cells: Object.fromEntries(PRINCIPALS.map(principal => [principal, { effect: 'allow', status: 200, prepare: () => spec.prepare(principal) }])) as Record<MatrixPrincipal, MatrixCell> }));
  cases.push({ key: 'POST /v1/shop/auth/logout', contract: 'public',
    cells: Object.fromEntries(PRINCIPALS.map(principal => [principal, principal === 'cache_token' ? {
      effect: 'deny', status: 403, errorCode: 'CSRF_INVALID', async prepare() {
        return { url: '/v1/shop/auth/logout', init: { method: 'POST', headers: headers(principal) }, snapshot: fixture.snapshot,
          async verify(response: Response, proof: MatrixProof) {
            await error(response, proof, 'CSRF_INVALID', 'invalid CSRF token');
          } };
      },
    } : {
      effect: 'allow', status: 200, async prepare() {
        const supplied = headers(principal);
        const human = ['owner', 'manager', 'staff', 'read_only', 'foreign_store'].includes(principal);
        if (human) supplied.authorization = 'Bearer ' + await createAdminSession(fixture.identityFor(principal).id);
        const hash = digest(supplied.authorization!.slice('Bearer '.length));
        const before = (await fixture.queryGlobal('SELECT id,admin_user_id,customer_id FROM session WHERE token_hash=$1', [hash])).rows;
        assert.equal(before.length, human ? 1 : 0, 'fresh human session or non-session service/agent bearer');
        const credential = principal === 'agent'
          ? (await fixture.queryGlobal('SELECT * FROM admin_api_token WHERE token_hash=$1', [hash])).rows : [];
        const customerSessions = await rows('SELECT * FROM session WHERE customer_id=$1 ORDER BY id', [fixture.expectedCustomerId]);
        return { url: '/v1/shop/auth/logout', init: { method: 'POST', headers: supplied }, async verify(response: Response, proof: MatrixProof) {
          await ok(response, proof);
          proof.equal((await fixture.queryGlobal('SELECT id FROM session WHERE token_hash=$1', [hash])).rows, [], 'logout revokes only presented session bearer when present', 'state');
          proof.equal(await rows('SELECT * FROM session WHERE customer_id=$1 ORDER BY id', [fixture.expectedCustomerId]), customerSessions, 'admin/service bearer does not become or revoke another customer session', 'state');
          if (principal === 'agent') proof.equal((await fixture.queryGlobal('SELECT * FROM admin_api_token WHERE token_hash=$1', [hash])).rows, credential, 'logout does not revoke agent API credential', 'state');
          const cookie = response.headers.get('set-cookie') ?? '';
          proof.ok(cookie.includes('sr_cust=;') && cookie.includes('sr_cust_csrf=;') && cookie.includes('Max-Age=0'), 'logout clears both customer cookies');
        } };
      },
    }])) as Record<MatrixPrincipal, MatrixCell> });
  return cases;
}

/** Supplemental negative controls run AFTER global matrix denials; 409 is never counted as authorization denial. */
export function createPublicAuthControls(fixture: Fixture): PublicAuthControl[] {
  const source = publicSource(fixture);
  const controls: PublicAuthControl[] = [];
  for (const principal of PRINCIPALS) {
    controls.push({ key: 'public login requires real customer password [' + principal + ']', status: 401, async prepare() {
      const s = await source.seed();
      return { url: '/v1/shop/auth/login', env: source.peer(), init: { method: 'POST', headers: source.headers(principal),
        body: JSON.stringify({ email: s.email, password: 'Incorrect-but-well-formed-password' }) }, snapshot: fixture.snapshot, async verify(response: Response, proof: MatrixProof) {
        await error(response, proof, 'INVALID_CREDENTIALS', 'invalid email or password');
        proof.equal((await source.rows('SELECT token_hash FROM session WHERE customer_id=$1 ORDER BY token_hash', [s.id])).map(row => row.token_hash), s.sessionHashes,
          'invalid password issues no session', 'state');
      } };
    } });
    controls.push({ key: 'valid reset capability cannot cross tenant [' + principal + ']', status: 409, async prepare() {
      const s = await source.seed(), capability = await source.issue(s, 'password_reset');
      return { url: '/v1/shop/auth/reset-password', env: source.peer(), init: { method: 'POST',
        headers: { ...source.headers(principal), 'x-store-slug': fixture.foreignStoreSlug },
        body: JSON.stringify({ token: capability.raw, password: 'Cross-tenant-password-' + randomUUID() }) }, snapshot: fixture.snapshot, async verify(response: Response, proof: MatrixProof) {
        await error(response, proof, 'TOKEN_INVALID', 'token is invalid, expired, or already used');
        proof.equal(await source.rows('SELECT password_hash FROM customer WHERE id=$1', [s.id]), [{ password_hash: s.passwordHash }], 'cross-store consume preserves original credential', 'state');
        proof.equal((await source.rows('SELECT used_at FROM customer_token WHERE id=$1', [capability.row.id]))[0]!.used_at, null, 'cross-store consume does not burn valid capability', 'state');
      } };
    } });
  }
  controls.push({ key: 'genuine customer bearer logout', status: 200, async prepare() {
    const s = await source.seed();
    return { url: '/v1/shop/auth/logout', init: { method: 'POST', headers: s.headers }, async verify(response: Response, proof: MatrixProof) {
      await ok(response, proof);
      proof.equal((await source.rows('SELECT token_hash FROM session WHERE customer_id=$1 ORDER BY token_hash', [s.id])).map(row => row.token_hash),
        [s.sessionHashes.find(hash => hash !== digest(s.headers.authorization!.slice(7)))], 'genuine customer logout revokes presented session & preserves second session', 'state');
    } };
  } });
  return controls;
}

