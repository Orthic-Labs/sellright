import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprint, hmacFingerprint, publicKeyFingerprint, saltedFingerprints, sha256Prefix } from './fingerprint.js';

const SALT = 'ab'.repeat(32);

describe('fingerprints', () => {
  it('HMAC fingerprints are deterministic, label-separated and never contain the secret', () => {
    const a = hmacFingerprint('s3cret-value', 'COOKIE_SECRET', SALT);
    expect(a).toBe(hmacFingerprint('s3cret-value', 'COOKIE_SECRET', SALT));
    expect(a).not.toBe(hmacFingerprint('s3cret-value', 'OTHER', SALT));
    expect(a).not.toBe(hmacFingerprint('s3cret-value2', 'COOKIE_SECRET', SALT));
    // a different installation salt yields a different value: no salt, no offline confirmation
    expect(a).not.toBe(hmacFingerprint('s3cret-value', 'COOKIE_SECRET', 'cd'.repeat(32)));
    expect(() => hmacFingerprint('x', 'L', 'short')).toThrow(/32 bytes/);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain('s3cret');
  });
  it('public-key fingerprint is identical from the private and the public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const fp = publicKeyFingerprint(publicKey);
    expect(fp).toBe(publicKeyFingerprint(privateKey));
    expect(fp).toBe(publicKeyFingerprint(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
  it('sha256 prefix and unset handling', () => {
    expect(sha256Prefix('abc')).toBe('ba7816bf8f01');
    expect(saltedFingerprints(SALT).symmetric(undefined, 'X')).toEqual({ set: false, fingerprint: null });
    expect(fingerprint.sha256Prefix('abc')).toEqual({ set: true, fingerprint: 'ba7816bf8f01' });
  });
});
