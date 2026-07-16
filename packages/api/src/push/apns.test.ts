/**
 * Unit tests for the APNs provider token. No network: signing is pure crypto,
 * and a malformed JWT fails as an opaque 403 from Apple at runtime — exactly the
 * kind of thing that must be caught here instead of in production.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';

// A real P-256 key, generated per run — the same curve Apple issues (.p8 is
// PKCS#8 EC prime256v1), so this exercises the actual ES256 path.
const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

vi.mock('../env.js', () => ({
  env: {
    APNS_KEY_P8: privateKey,
    APNS_KEY_ID: 'ABC123DEFG',
    APNS_TEAM_ID: '6KLGD3LLKF',
    APNS_BUNDLE_ID: 'app.sellright.ios.admin',
    APNS_DEFAULT_ENVIRONMENT: 'production',
  },
}));

const { mintProviderToken, resetProviderToken, apnsConfigured } = await import('./apns.js');

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

beforeEach(() => resetProviderToken());

describe('mintProviderToken', () => {
  it('produces a base64url ES256 JWT whose signature verifies against the key', () => {
    const jwt = mintProviderToken();
    const [header, claims, signature] = jwt.split('.');
    expect(header && claims && signature).toBeTruthy();

    // base64url: no +, /, or = padding. Apple rejects standard base64 outright.
    expect(jwt).not.toMatch(/[+/=]/);

    expect(decodeSegment(header!)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    const parsed = decodeSegment(claims!) as { iss: string; iat: number };
    expect(parsed.iss).toBe('6KLGD3LLKF');
    expect(parsed.iat).toBeCloseTo(Math.floor(Date.now() / 1000), -1);

    // The signature must be raw r||s (ieee-p1363), NOT DER — Apple silently 403s
    // a DER-encoded ES256 signature, which is invisible without this check.
    const raw = Buffer.from(signature!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(raw).toHaveLength(64);

    const verifier = createVerify('SHA256');
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
  });

  it('caches within the TTL and re-mints after it', () => {
    const now = Date.now();
    const first = mintProviderToken(now);
    expect(mintProviderToken(now + 60_000)).toBe(first); // same hour: reuse

    // Past the 50m refresh window: a new token (Apple rejects tokens > 1h, and
    // rate-limits providers that mint one per push).
    const later = mintProviderToken(now + 51 * 60_000);
    expect(later).not.toBe(first);
  });

  it('accepts a \\n-escaped key, since env vars cannot hold real newlines', async () => {
    vi.resetModules();
    vi.doMock('../env.js', () => ({
      env: {
        APNS_KEY_P8: privateKey.replace(/\n/g, '\\n'),
        APNS_KEY_ID: 'ABC123DEFG',
        APNS_TEAM_ID: '6KLGD3LLKF',
        APNS_BUNDLE_ID: 'app.sellright.ios.admin',
        APNS_DEFAULT_ENVIRONMENT: 'production',
      },
    }));
    const mod = await import('./apns.js');
    expect(() => mod.mintProviderToken()).not.toThrow();
  });
});

describe('apnsConfigured', () => {
  it('is true when the full key set is present', () => {
    expect(apnsConfigured()).toBe(true);
  });
});
