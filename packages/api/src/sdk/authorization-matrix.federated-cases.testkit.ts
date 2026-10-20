/** Synthetic federated trust roots qualify route contracts, never real Google/Apple issuers. */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { _resetAppleJwksCache, verifyAppleIdentityToken } from '../auth/apple.js';
import { verifyFederatedLink } from '../auth/federated-link.js';
import { invalidateStoreCache } from '../store-context.js';
import type { MatrixIdentityFixture } from './authorization-matrix.identity-cases.testkit.js';
import { PRINCIPALS, type MatrixCase, type MatrixPrincipal, type MatrixProof, type PreparedMatrixCell } from './authorization-matrix.testkit.js';

type Fixture = MatrixIdentityFixture & { foreignStoreSlug: string };
type Provider = 'apple' | 'google';
type Claims = Record<string, any>;
type Customer = { id: string; email: string; subject: string; provider: Provider };
type Flow = Customer & { token: string; nonce: string; redemption: { jti: string; exp: number }; mail: unknown };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const APPLE_AUD = 'com.sellright.matrix.synthetic';
const GOOGLE_AUD = 'matrix-synthetic-client.apps.googleusercontent.com';
const GOOGLE_OTHER_AUD = 'matrix-other-client.apps.googleusercontent.com';
const APPLE_ISS = 'https://appleid.apple.com';
const GOOGLE_ISS = 'https://accounts.google.com';
const GOOGLE_INFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=[synthetic-redacted]';

export interface FederatedTransport {
  /** Compose into installAuthorizationTransport({federatedFetch}); no ambient fetch replacement here. */
  fetch(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response | undefined>;
  mint(provider: Provider, overrides?: Claims, wrongKey?: boolean): string;
}

/** Synthetic RSA keys supplied only through existing provider I/O seams. Apple RS256 verifier stays real.
 * Google delegates crypto to tokeninfo in production: this local tokeninfo adapter verifies registered synthetic
 * JWT signatures/issuer/expiry; Google's application audience check still runs in verifyGoogleIdToken.
 */
export function resetFederatedCaches(): void { _resetAppleJwksCache(); }

export function createFederatedTransport(): FederatedTransport {
  const trusted = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const untrusted = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'matrix-synthetic-' + randomUUID(), issuedGoogle = new Set<string>();
  const jwk = { ...trusted.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  _resetAppleJwksCache();
  function mint(provider: Provider, overrides: Claims = {}, wrongKey = false): string {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: provider === 'apple' ? APPLE_ISS : GOOGLE_ISS, aud: provider === 'apple' ? APPLE_AUD : GOOGLE_AUD,
      sub: 'synthetic-' + randomUUID(), iat: now, exp: now + 600, email_verified: true, ...overrides };
    const input = encode({ alg: 'RS256', kid, typ: 'JWT' }) + '.' + encode(claims);
    const token = input + '.' + sign('RSA-SHA256', Buffer.from(input), wrongKey ? untrusted.privateKey : trusted.privateKey).toString('base64url');
    if (provider === 'google') issuedGoogle.add(token);
    return token;
  }
  return { mint, async fetch(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET') return undefined;
    if (url.href === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [jwk] });
    if (url.origin !== 'https://oauth2.googleapis.com' || url.pathname !== '/tokeninfo' ||
      [...url.searchParams.keys()].length !== 1 || !url.searchParams.has('id_token')) return undefined;
    const token = url.searchParams.get('id_token')!;
    if (!issuedGoogle.has(token)) return undefined;
    let claims: Claims | undefined;
    try {
      const [headerPart, payloadPart, signaturePart, extra] = token.split('.');
      const header = JSON.parse(Buffer.from(headerPart!, 'base64url').toString()), payload = JSON.parse(Buffer.from(payloadPart!, 'base64url').toString());
      const valid = !extra && header.alg === 'RS256' && header.kid === kid &&
        verify('RSA-SHA256', Buffer.from(headerPart + '.' + payloadPart), trusted.publicKey as KeyObject, Buffer.from(signaturePart!, 'base64url')) &&
        payload.iss === GOOGLE_ISS && typeof payload.exp === 'number' && payload.exp > Date.now() / 1000 &&
        [GOOGLE_AUD, GOOGLE_OTHER_AUD].includes(payload.aud);
      if (valid) claims = payload;
    } catch { /* synthetic tokeninfo rejects invalid cryptographic claims */ }
    return claims ? Response.json(claims) : Response.json({ error: 'invalid_token', error_description: 'synthetic token verification failed' }, { status: 400 });
  } };
}

function federatedSource(fixture: Fixture, adapter: FederatedTransport) {
  const rows = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  let peerId = 0;
  const peer = () => ({ remoteAddr: '198.19.' + Math.floor(++peerId / 250) + '.' + (peerId % 250 + 1) });
  const headers = (principal?: MatrixPrincipal) => ({ ...(principal ? fixture.requestHeaders[principal] : {}),
    'x-store-slug': fixture.storeSlug, 'content-type': 'application/json' });
  const init = (body: unknown, principal?: MatrixPrincipal): RequestInit => ({ method: 'POST', headers: headers(principal), body: JSON.stringify(body) });
  const post = (url: string, body: unknown, principal?: MatrixPrincipal) => fixture.request(url, init(body, principal), peer());
  const tokenBody = (provider: Provider, token: string) => provider === 'apple' ? { identityToken: token } : { credential: token };
  async function configure() {
    await rows(`UPDATE store SET config=COALESCE(config,'{}'::jsonb) || jsonb_build_object('googleClientId',$2::text,
      'auth',COALESCE(config->'auth','{}'::jsonb) || jsonb_build_object('appleClientId',$3::text)) WHERE id=$1`, [fixture.storeId, GOOGLE_AUD, APPLE_AUD]);
    invalidateStoreCache(fixture.storeSlug);
  }
  async function seed(provider: Provider, authoritative = true): Promise<Customer> {
    await configure();
    const id = randomUUID(), subject = 'matrix-' + provider + '-' + randomUUID();
    const email = 'federated-' + id + (authoritative ? provider === 'apple' ? '@icloud.com' : '@gmail.com' : '@matrix.invalid');
    await rows(`INSERT INTO customer (id,store_id,email,first_name,last_name,email_verified) VALUES ($1,$2,$3,'Synthetic','Customer',true)`, [id, fixture.storeId, email]);
    return { id, email, subject, provider };
  }
  const credential = (s: Customer, overrides: Claims = {}, wrongKey = false) => adapter.mint(s.provider, { sub: s.subject, email: s.email,
    ...(s.provider === 'google' ? { given_name: 'Provider', family_name: 'Claims' } : {}), ...overrides }, wrongKey);
  async function session(response: Response, proof: MatrixProof, s: Customer, existing: string[] = []) {
    const result = await response.json() as Claims;
    proof.equal(Object.keys(result).sort(), ['customer', 'token'], 'exact federated sign-in response fields');
    proof.equal(result.customer, { id: s.id, email: s.email, firstName: 'Synthetic', lastName: 'Customer', phone: null, emailVerified: true, isMigrated: true },
      'verified body identity links existing intended customer independently of supplied admin headers');
    proof.ok(typeof result.token === 'string' && result.token.length === 64, 'new opaque customer session');
    const hash = digest(result.token);
    proof.ok(!existing.includes(hash), 'fresh session is independent of existing sessions');
    proof.equal(await rows('SELECT store_id,customer_id,admin_user_id FROM session WHERE token_hash=$1', [hash]),
      [{ store_id: fixture.storeId, customer_id: s.id, admin_user_id: null }], 'committed session is tenant-bound customer identity', 'state');
    proof.equal((await rows('SELECT token_hash FROM session WHERE customer_id=$1 ORDER BY token_hash', [s.id])).map(row => row.token_hash),
      [...existing, hash].sort(), 'exact resulting customer session set', 'state');
    proof.equal(await rows('SELECT email,email_verified,password_hash,google_sub,apple_user_id FROM customer WHERE id=$1', [s.id]),
      [{ email: s.email, email_verified: true, password_hash: null, google_sub: s.provider === 'google' ? s.subject : null,
        apple_user_id: s.provider === 'apple' ? s.subject : null }], 'only verified provider subject linked to existing passwordless customer', 'state');
    const cookies = response.headers.get('set-cookie') ?? '';
    proof.ok(cookies.includes('sr_cust=' + result.token + '; HttpOnly;') && cookies.includes('Secure') && cookies.includes('sr_cust_csrf='),
      'customer cookie & CSRF cookie bind returned session');
  }
  async function flow(provider: Provider): Promise<Flow> {
    const s = await seed(provider, false);
    const beforeCustomer = await rows('SELECT * FROM customer WHERE id=$1', [s.id]);
    const response = await post('/v1/shop/auth/' + provider, tokenBody(provider, credential(s)));
    assert.equal(response.status, 202, 'real non-authoritative provider identity starts mailbox proof');
    const result = await response.json() as Claims;
    assert.deepEqual(Object.keys(result).sort(), ['nonce', 'verificationRequired']);
    assert.equal(result.verificationRequired, true);
    assert.ok(typeof result.nonce === 'string' && result.nonce.length >= 20);
    const cookie = response.headers.get('set-cookie') ?? '';
    assert.ok(cookie.includes('sr_fed_link=' + result.nonce + '; HttpOnly;') && !cookie.includes('sr_cust='));
    assert.deepEqual(await rows('SELECT * FROM customer WHERE id=$1', [s.id]), beforeCustomer, 'mail issuance cannot link by untrusted email claim');
    assert.deepEqual(await rows('SELECT id FROM session WHERE customer_id=$1', [s.id]), []);
    const mails = await rows('SELECT kind,recipient,status,attempts,payload FROM email_outbox WHERE recipient=$1 ORDER BY id', [s.email]);
    assert.equal(mails.length, 1);
    const mail = mails[0]!;
    assert.deepEqual({ kind: mail.kind, recipient: mail.recipient, status: mail.status, attempts: mail.attempts },
      { kind: 'federated_link_confirm', recipient: s.email, status: 'pending', attempts: 0 });
    const token = /sign-in\/confirm\?token=([^\s")<]+)/.exec(mail.payload.text)?.[1];
    assert.ok(token, 'real transactional outbox contains signed confirmation capability');
    const claims = verifyFederatedLink(token, fixture.storeId);
    assert.ok(claims);
    assert.deepEqual({ provider: claims.provider, subject: claims.subject, email: claims.email, storeId: claims.storeId },
      { provider, subject: s.subject, email: s.email, storeId: fixture.storeId });
    assert.equal(claims.nonceHash, digest(result.nonce));
    assert.deepEqual(await rows('SELECT jti_hash FROM federated_link_redemption WHERE jti_hash=$1', [digest(claims.jti)]), []);
    return { ...s, token, nonce: result.nonce, redemption: { jti: claims.jti, exp: claims.exp }, mail };
  }
  async function confirmed(response: Response, proof: MatrixProof, s: Flow) {
    await session(response, proof, s);
    proof.equal(await rows('SELECT jti_hash,expires_at FROM federated_link_redemption WHERE jti_hash=$1', [digest(s.redemption.jti)]),
      [{ jti_hash: digest(s.redemption.jti), expires_at: new Date(s.redemption.exp) }], 'real mailed capability consumed exactly once', 'state');
    proof.equal(await rows('SELECT kind,recipient,status,attempts,payload FROM email_outbox WHERE recipient=$1 ORDER BY id', [s.email]),
      [s.mail], 'redemption creates no second notification', 'state');
    proof.ok((response.headers.get('set-cookie') ?? '').includes('sr_fed_link=;'), 'initiator nonce cookie cleared after redemption');
  }
  return { rows, peer, headers, init, post, tokenBody, configure, seed, credential, session, flow, confirmed };
}

/** All eight supplied header identities share public-body contracts; each valid body proves its own customer authority. */
export function createFederatedCases(fixture: Fixture, adapter: FederatedTransport): MatrixCase[] {
  const source = federatedSource(fixture, adapter);
  const make = (prepare: (principal: MatrixPrincipal) => Promise<PreparedMatrixCell>) => ({
    owner: { effect: 'allow' as const, status: 200, prepare: () => prepare('owner') },
    manager: { effect: 'allow' as const, status: 200, prepare: () => prepare('manager') },
    staff: { effect: 'allow' as const, status: 200, prepare: () => prepare('staff') },
    read_only: { effect: 'allow' as const, status: 200, prepare: () => prepare('read_only') },
    agent: { effect: 'allow' as const, status: 200, prepare: () => prepare('agent') },
    foreign_store: { effect: 'allow' as const, status: 200, prepare: () => prepare('foreign_store') },
    release_service: { effect: 'allow' as const, status: 200, prepare: () => prepare('release_service') },
    cache_token: { effect: 'allow' as const, status: 200, prepare: () => prepare('cache_token') },
  });
  const cases: MatrixCase[] = (['apple', 'google'] as const).map(provider => ({
    key: 'POST /v1/shop/auth/' + provider, contract: 'public',
    cells: make(async principal => {
      const s = await source.seed(provider);
      return { url: '/v1/shop/auth/' + provider, env: source.peer(), init: source.init(source.tokenBody(provider, source.credential(s)), principal),
        verify: (response: Response, proof: MatrixProof) => source.session(response, proof, s) };
    }),
  }));
  cases.push({ key: 'POST /v1/shop/auth/federated/confirm', contract: 'capability',
    cells: make(async principal => {
      const s = await source.flow(PRINCIPALS.indexOf(principal) % 2 ? 'apple' : 'google');
      return { url: '/v1/shop/auth/federated/confirm', env: source.peer(), init: source.init({ token: s.token, nonce: s.nonce }, principal),
        verify: (response: Response, proof: MatrixProof) => source.confirmed(response, proof, s) };
    }),
  });
  return cases;
}

/** Supplemental invalid-body controls do not count as route/principal cells. */
export async function runFederatedControls(fixture: Fixture, adapter: FederatedTransport): Promise<void> {
  const source = federatedSource(fixture, adapter);
  const proof: MatrixProof = {
    equal(actual, expected, label) { assert.deepEqual(actual, expected, label); },
    ok(condition, label): asserts condition { assert.ok(condition, label); },
  };
  async function denial(url: string, requestBody: unknown, code: string, message: string, expectedProviderReads: unknown[] = []) {
    const before = structuredClone(await fixture.snapshot()) as { data: unknown; files: unknown; providerCalls: unknown[] };
    const response = await source.post(url, requestBody, 'owner');
    assert.equal(response.status, 401, 'body credential rejection status');
    const requestId = response.headers.get('x-request-id');
    assert.ok(requestId);
    assert.deepEqual(await response.json(), { error: { code, message, requestId } }, 'exact uniform invalid body credential envelope');
    const after = await fixture.snapshot() as typeof before;
    assert.deepEqual({ data: after.data, files: after.files }, { data: before.data, files: before.files }, 'invalid credential changes no complete domain/outbox/file state');
    assert.deepEqual(after.providerCalls, [...before.providerCalls, ...expectedProviderReads], 'only named read-only synthetic provider authentication calls occur');
  }
  for (const provider of ['apple', 'google'] as const) {
    const s = await source.seed(provider);
    // Warm only Apple's existing JWKS cache through its real verifier, before negative snapshots.
    if (provider === 'apple') assert.ok(await verifyAppleIdentityToken(source.credential(s), APPLE_AUD));
    const variants: Array<{ label: string; claims: Claims; wrongKey?: boolean; tokenInfoStatus?: number }> = [
      { label: 'signature', claims: {}, wrongKey: true, tokenInfoStatus: 400 },
      { label: 'issuer', claims: { iss: 'https://wrong-issuer.matrix.invalid' }, tokenInfoStatus: 400 },
      { label: 'audience', claims: { aud: provider === 'apple' ? 'com.other.synthetic' : GOOGLE_OTHER_AUD }, tokenInfoStatus: 200 },
      { label: 'expiry', claims: { exp: Math.floor(Date.now() / 1000) - 60 }, tokenInfoStatus: 400 },
      { label: 'email-verification', claims: { email_verified: false }, tokenInfoStatus: 200 },
    ];
    for (const variant of variants) {
      const token = source.credential(s, variant.claims, variant.wrongKey);
      await denial('/v1/shop/auth/' + provider, source.tokenBody(provider, token), provider === 'apple' ? 'APPLE_TOKEN_INVALID' : 'GOOGLE_TOKEN_INVALID',
        provider === 'apple' ? 'invalid Apple identity token' : 'invalid or unverified Google token',
        provider === 'google' ? [{ kind: 'federated', method: 'GET', url: GOOGLE_INFO, response: { status: variant.tokenInfoStatus } }] : []);
    }
    // Returning subjects own identity; a changed email claim cannot choose a different customer.
    let response = await source.post('/v1/shop/auth/' + provider, source.tokenBody(provider, source.credential(s)));
    assert.equal(response.status, 200);
    const signed = await response.clone().json() as Claims;
    await source.session(response, proof, s);
    const changed = source.credential(s, provider === 'apple' ? { email: undefined } : { email: 'other-' + randomUUID() + '@gmail.com' });
    response = await source.post('/v1/shop/auth/' + provider, source.tokenBody(provider, changed));
    assert.equal(response.status, 200);
    await source.session(response, proof, s, [digest(signed.token)]);
  }
  for (const provider of ['apple', 'google'] as const) {
    const s = await source.flow(provider), path = '/v1/shop/auth/federated/confirm';
    const invalidMessage = 'this confirmation link is invalid, expired, or was already used — start the sign-in again in this browser';
    const [payload, signature] = s.token.split('.');
    const forged = payload + '.' + (signature![0] === 'A' ? 'B' : 'A') + signature!.slice(1);
    await denial(path, { token: forged, nonce: s.nonce }, 'TOKEN_INVALID', invalidMessage);
    await denial(path, { token: s.token, nonce: 'different-browser-' + randomUUID() }, 'TOKEN_INVALID', invalidMessage);
    await denial(path, { token: s.token }, 'TOKEN_INVALID', invalidMessage);
    // Wrong-tenant delivery never spends this store's issued capability.
    const before = structuredClone(await fixture.snapshot());
    const foreign = await fixture.request(path, { method: 'POST', headers: { 'x-store-slug': fixture.foreignStoreSlug, 'content-type': 'application/json' },
      body: JSON.stringify({ token: s.token, nonce: s.nonce }) }, source.peer());
    assert.equal(foreign.status, 401);
    const foreignRequestId = foreign.headers.get('x-request-id');
    assert.ok(foreignRequestId);
    assert.deepEqual(await foreign.json(), { error: { code: 'TOKEN_INVALID', message: invalidMessage, requestId: foreignRequestId } }, 'wrong tenant gets exact uniform capability rejection');
    assert.deepEqual(await fixture.snapshot(), before, 'wrong tenant cannot consume valid mailed capability');
    const response = provider === 'apple'
      ? await fixture.request(path, { method: 'POST', headers: { ...source.headers(), cookie: 'sr_fed_link=' + s.nonce }, body: JSON.stringify({ token: s.token }) }, source.peer())
      : await source.post(path, { token: s.token, nonce: s.nonce });
    assert.equal(response.status, 200);
    await source.confirmed(response, proof, s);
    await denial(path, { token: s.token, nonce: s.nonce }, 'TOKEN_INVALID', invalidMessage);
  }
}
