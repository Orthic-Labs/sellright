import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { FEDERATED_LINK_TTL_MS, FederatedLinkUnavailableError, MIN_LINK_SECRET_LENGTH, deriveLinkKey, hashLinkNonce, newLinkNonce, nonceMatches, signFederatedLink, verifyFederatedLink } from './federated-link.js';

const KEY = deriveLinkKey('k'.repeat(40), 'production');
const claims = { provider: 'google' as const, storeId: 'store-1', subject: 'g-1', email: 'a@corp.example', firstName: 'A', lastName: null };
const nh = hashLinkNonce('nonce-1');

describe('deriveLinkKey', () => {
  it('derives a purpose key, never the raw secret', () => {
    const raw = 's'.repeat(40);
    expect(deriveLinkKey(raw, 'production').equals(createHmac('sha256', raw).update('sellright/federated-link/v1').digest())).toBe(true);
    expect(deriveLinkKey(raw, 'production').equals(Buffer.from(raw))).toBe(false);
  });
  it('is stable for one secret and differs between secrets', () => {
    expect(deriveLinkKey('a'.repeat(32), 'production').equals(deriveLinkKey('a'.repeat(32), 'production'))).toBe(true);
    expect(deriveLinkKey('a'.repeat(32), 'production').equals(deriveLinkKey('b'.repeat(32), 'production'))).toBe(false);
  });
  it('fails closed in production for an empty, missing or short secret', () => {
    for (const raw of [undefined, '', 'x'.repeat(MIN_LINK_SECRET_LENGTH - 1)]) {
      expect(() => deriveLinkKey(raw, 'production')).toThrow(FederatedLinkUnavailableError);
    }
  });
  it('outside production falls back to a random per-process key instead of a guessable one', () => {
    const a = deriveLinkKey('', 'development');
    const b = deriveLinkKey(undefined, 'test');
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(deriveLinkKey('', 'development'))).toBe(false);
  });
});

describe('federated link token', () => {
  it('round-trips for the same store before expiry, carrying provider, nonce hash and a jti', () => {
    const tok = signFederatedLink(claims, nh, 1_000, KEY);
    const v = verifyFederatedLink(tok, 'store-1', 1_000 + FEDERATED_LINK_TTL_MS - 1, KEY);
    expect(v).toMatchObject({ ...claims, nonceHash: nh, exp: 1_000 + FEDERATED_LINK_TTL_MS });
    expect(v!.jti.length).toBeGreaterThan(10);
  });
  it('gives every token its own jti', () => {
    const j = (t: string) => verifyFederatedLink(t, 'store-1', 1_001, KEY)!.jti;
    expect(j(signFederatedLink(claims, nh, 1_000, KEY))).not.toBe(j(signFederatedLink(claims, nh, 1_000, KEY)));
  });
  it('rejects expiry, another store, another key, tampering and garbage', () => {
    const tok = signFederatedLink(claims, nh, 1_000, KEY);
    expect(verifyFederatedLink(tok, 'store-1', 1_000 + FEDERATED_LINK_TTL_MS, KEY)).toBeNull();
    expect(verifyFederatedLink(tok, 'store-2', 1_001, KEY)).toBeNull();
    expect(verifyFederatedLink(tok, 'store-1', 1_001, deriveLinkKey('z'.repeat(40), 'production'))).toBeNull();
    const [body, sig] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, p: 'google', st: 'store-1', sub: 'g-2', em: 'a@corp.example', nh, jti: 'j', exp: 9e15 })).toString('base64url');
    expect(verifyFederatedLink(`${forged}.${sig}`, 'store-1', 1_001, KEY)).toBeNull();
    expect(verifyFederatedLink(body!, 'store-1', 1_001, KEY)).toBeNull();
    expect(verifyFederatedLink('not-a-token', 'store-1', 1_001, KEY)).toBeNull();
  });
  it('rejects an unknown provider even when correctly signed', () => {
    const body = Buffer.from(JSON.stringify({ v: 1, p: 'facebook', st: 'store-1', sub: 's', em: 'a@b.c', nh, jti: 'j', exp: 9e15 })).toString('base64url');
    const tok = `${body}.${createHmac('sha256', KEY).update(body).digest('base64url')}`;
    expect(verifyFederatedLink(tok, 'store-1', 1, KEY)).toBeNull();
  });
});

describe('nonceMatches', () => {
  it('accepts only the nonce the token was bound to', () => {
    const n = newLinkNonce();
    expect(nonceMatches(n, hashLinkNonce(n))).toBe(true);
    expect(nonceMatches(newLinkNonce(), hashLinkNonce(n))).toBe(false);
    expect(nonceMatches('', hashLinkNonce(n))).toBe(false);
    expect(nonceMatches(undefined, hashLinkNonce(n))).toBe(false);
  });
});
