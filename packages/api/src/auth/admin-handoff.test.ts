import { describe, expect, it } from 'vitest';
import { s256 } from './admin-handoff.js';
import { parseHandoffClients, parseHandoffIssuer } from './admin-handoff-config.js';

const HEX = 'a'.repeat(64);

describe('parseHandoffClients', () => {
  it('is empty when unset', () => {
    expect(parseHandoffClients(undefined)).toEqual([]);
    expect(parseHandoffClients('')).toEqual([]);
  });

  it('accepts exact https callbacks (and http only on localhost)', () => {
    const raw = JSON.stringify([{ id: 'hub', redirectUri: 'https://admin.sellright.cc/v1/hub/callback', secretSha256: HEX },
      { id: 'dev-hub', redirectUri: 'http://localhost:3300/v1/hub/callback', secretSha256: HEX }]);
    expect(parseHandoffClients(raw).map((c) => c.id)).toEqual(['hub', 'dev-hub']);
  });

  it.each([
    ['not an array', '{"id":"hub"}'],
    ['repeated id', JSON.stringify([{ id: 'hub', redirectUri: 'https://a.test/cb', secretSha256: HEX }, { id: 'hub', redirectUri: 'https://b.test/cb', secretSha256: HEX }])],
    ['bad id', JSON.stringify([{ id: 'H', redirectUri: 'https://a.test/cb', secretSha256: HEX }])],
    ['secret not hex', JSON.stringify([{ id: 'hub', redirectUri: 'https://a.test/cb', secretSha256: 'plaintext' }])],
    ['plain http', JSON.stringify([{ id: 'hub', redirectUri: 'http://a.test/cb', secretSha256: HEX }])],
    ['query', JSON.stringify([{ id: 'hub', redirectUri: 'https://a.test/cb?x=1', secretSha256: HEX }])],
    ['fragment', JSON.stringify([{ id: 'hub', redirectUri: 'https://a.test/cb#x', secretSha256: HEX }])],
    ['credentials', JSON.stringify([{ id: 'hub', redirectUri: 'https://u:p@a.test/cb', secretSha256: HEX }])],
    ['not canonical', JSON.stringify([{ id: 'hub', redirectUri: 'https://A.test/cb', secretSha256: HEX }])],
    ['invalid JSON', '{nope'],
  ])('throws on %s', (_label, raw) => {
    expect(() => parseHandoffClients(raw)).toThrow();
  });

  it('never echoes the raw value in its error', () => {
    expect(() => parseHandoffClients('{"secret-ish-value"')).toThrow('ADMIN_HANDOFF_CLIENTS is not valid JSON');
  });

  it('refuses http localhost callbacks in production', () => {
    const raw = JSON.stringify([{ id: 'dev-hub', redirectUri: 'http://localhost:3300/cb', secretSha256: HEX }]);
    expect(() => parseHandoffClients(raw, true)).toThrow();
  });
});

describe('parseHandoffIssuer', () => {
  it('accepts a bare https origin, with or without the trailing slash', () => {
    expect(parseHandoffIssuer('https://rottenhand.com')).toBe('https://rottenhand.com');
    expect(parseHandoffIssuer('https://rottenhand.com/')).toBe('https://rottenhand.com');
  });
  it.each(['https://rottenhand.com/admin', 'http://rottenhand.com', 'https://rottenhand.com?x=1', 'not a url'])('refuses %s', (raw) => {
    expect(() => parseHandoffIssuer(raw)).toThrow();
  });
  it('refuses http localhost in production', () => {
    expect(parseHandoffIssuer('http://localhost:3300')).toBe('http://localhost:3300');
    expect(() => parseHandoffIssuer('http://localhost:3300', true)).toThrow();
  });
});

describe('s256', () => {
  it('is unpadded base64url(sha256(verifier)) (vector computed independently with Python hashlib)', () => {
    expect(s256('dBjftJeZ4CVP-mB92K27uhbUJU9p1r_Ct2DlCoaFAOI')).toBe('wrZPUKPamfNr3RxnB_k5nKKjhUnt8xOviIfAd1zljog');
  });
});
