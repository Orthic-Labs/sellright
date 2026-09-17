/**
 * Unit tests for Sign-in-with-Apple identity-token verification (ported from
 * RightSites). fetch to appleid.apple.com is mocked; tokens are REAL RS256
 * JWTs signed by a throwaway keypair generated in the test, so signature
 * verification runs the same node:crypto path as production.
 *
 * Covers: valid token, wrong audience (the suite-critical rejection — a
 * client can claim any aud, only the server-side allowlist decides), expired,
 * wrong issuer, bad signature, unknown kid, malformed input, and the
 * appleClientIds config resolution (per-store over env).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { _resetAppleJwksCache, appleClientIds, verifyAppleIdentityToken } from './apple.js';

const AUD = 'com.example.app';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubJwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
const JWKS = { keys: [{ ...pubJwk, kid: 'test-kid', use: 'sig', alg: 'RS256' }] };

const b64u = (o: object | string) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function makeJwt(payload: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: typeof privateKey } = {}): string {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'test-kid', typ: 'JWT' };
  const input = `${b64u(header)}.${b64u(payload)}`;
  const sig = cryptoSign('RSA-SHA256', Buffer.from(input), opts.key ?? privateKey).toString('base64url');
  return `${input}.${sig}`;
}

function goodPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://appleid.apple.com',
    aud: AUD,
    sub: '001234.abcdef.5678',
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    email: 'person@example.com',
    email_verified: 'true',
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetAppleJwksCache();
  fetchMock = vi.fn(async () => new Response(JSON.stringify(JWKS), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('verifyAppleIdentityToken', () => {
  it('accepts a valid token and returns the identity', async () => {
    const id = await verifyAppleIdentityToken(makeJwt(goodPayload()), AUD);
    expect(id).toEqual({ sub: '001234.abcdef.5678', email: 'person@example.com', emailVerified: true, isPrivateRelay: false });
  });

  it('rejects a wrong audience — the server-side allowlist decides, never the client', async () => {
    const token = makeJwt(goodPayload({ aud: 'com.evil.impersonator' }));
    expect(await verifyAppleIdentityToken(token, AUD)).toBeNull();
    // a client-supplied bundle id does not widen what's accepted either:
    expect(await verifyAppleIdentityToken(makeJwt(goodPayload()), 'com.evil.impersonator')).toBeNull();
  });

  it('rejects expired / wrong-issuer / missing-sub tokens', async () => {
    expect(await verifyAppleIdentityToken(makeJwt(goodPayload({ exp: Math.floor(Date.now() / 1000) - 10 })), AUD)).toBeNull();
    expect(await verifyAppleIdentityToken(makeJwt(goodPayload({ iss: 'https://not-apple.example' })), AUD)).toBeNull();
    const noSub = goodPayload(); delete noSub.sub;
    expect(await verifyAppleIdentityToken(makeJwt(noSub), AUD)).toBeNull();
  });

  it('rejects a bad signature and an unknown kid', async () => {
    expect(await verifyAppleIdentityToken(makeJwt(goodPayload(), { key: otherKey }), AUD)).toBeNull();
    expect(await verifyAppleIdentityToken(makeJwt(goodPayload(), { kid: 'no-such-kid' }), AUD)).toBeNull();
  });

  it('rejects malformed input and a non-RS256 header', async () => {
    expect(await verifyAppleIdentityToken('not-a-jwt', AUD)).toBeNull();
    expect(await verifyAppleIdentityToken('a.b', AUD)).toBeNull();
    expect(await verifyAppleIdentityToken(`${b64u('x')}.${b64u('y')}.`, AUD)).toBeNull();
    expect(await verifyAppleIdentityToken(makeJwt(goodPayload(), { alg: 'HS256' }), AUD)).toBeNull();
  });

  it('maps Private Relay + boolean email_verified forms', async () => {
    const id = await verifyAppleIdentityToken(
      makeJwt(goodPayload({ email: 'x@privaterelay.appleid.com', email_verified: true, is_private_email: 'true' })), AUD);
    expect(id?.isPrivateRelay).toBe(true);
    expect(id?.emailVerified).toBe(true);
  });

  it('caches the JWKS fetch for an hour', async () => {
    await verifyAppleIdentityToken(makeJwt(goodPayload()), AUD);
    await verifyAppleIdentityToken(makeJwt(goodPayload({ sub: 'other' })), AUD);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    _resetAppleJwksCache();
    await verifyAppleIdentityToken(makeJwt(goodPayload()), AUD);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when the JWKS fetch fails (no oracle)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }));
    expect(await verifyAppleIdentityToken(makeJwt(goodPayload()), AUD)).toBeNull();
  });
});

describe('appleClientIds', () => {
  it('reads per-store config first (string or array)', () => {
    expect(appleClientIds({ auth: { appleClientId: 'com.store.ios' } })).toEqual(['com.store.ios']);
    expect(appleClientIds({ auth: { appleClientId: ['com.store.ios', 'com.store.web'] } })).toEqual(['com.store.ios', 'com.store.web']);
  });

  it('trims and drops empties', () => {
    expect(appleClientIds({ auth: { appleClientId: ['  a.b  ', '', 'c.d'] } })).toEqual(['a.b', 'c.d']);
  });
});
