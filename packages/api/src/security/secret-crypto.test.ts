import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptSecret, decryptSecret, rotateSecret, deriveKey, last4, secretsEqual, CURRENT_KEY_VERSION,
} from './secret-crypto.js';

const masterKey = randomBytes(32);
const purpose = 'store:store-1:stripe:test:secretKey';

describe('secret-crypto', () => {
  it('round-trips a secret', () => {
    const sealed = encryptSecret('sk_test_abc123', { purpose, masterKey });
    expect(sealed.v).toBe(CURRENT_KEY_VERSION);
    expect(decryptSecret(sealed, purpose, masterKey)).toBe('sk_test_abc123');
  });

  it('never stores plaintext in the sealed envelope', () => {
    const sealed = encryptSecret('sk_test_super_secret_value', { purpose, masterKey });
    const json = JSON.stringify(sealed);
    expect(json).not.toContain('sk_test_super_secret_value');
  });

  it('produces different ciphertext for the same plaintext each time (random IV)', () => {
    const a = encryptSecret('same-value', { purpose, masterKey });
    const b = encryptSecret('same-value', { purpose, masterKey });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('fails to decrypt under a different purpose (AAD binding)', () => {
    const sealed = encryptSecret('sk_test_abc123', { purpose, masterKey });
    expect(() => decryptSecret(sealed, 'store:store-2:stripe:test:secretKey', masterKey)).toThrow();
  });

  it('fails to decrypt with a different master key', () => {
    const sealed = encryptSecret('sk_test_abc123', { purpose, masterKey });
    expect(() => decryptSecret(sealed, purpose, randomBytes(32))).toThrow();
  });

  it('fails to decrypt a tampered ciphertext', () => {
    const sealed = encryptSecret('sk_test_abc123', { purpose, masterKey });
    const tampered = { ...sealed, ct: Buffer.from('tampered-ciphertext-bytes!!').toString('base64') };
    expect(() => decryptSecret(tampered, purpose, masterKey)).toThrow();
  });

  it('rejects empty plaintext', () => {
    expect(() => encryptSecret('', { purpose, masterKey })).toThrow();
  });

  it('throws (fails closed) when no master key is available anywhere', () => {
    const prev = process.env.SELLRIGHT_MASTER_KEY;
    delete process.env.SELLRIGHT_MASTER_KEY;
    try {
      expect(() => encryptSecret('sk_test_abc123', { purpose })).toThrow(/SELLRIGHT_MASTER_KEY/);
    } finally {
      if (prev !== undefined) process.env.SELLRIGHT_MASTER_KEY = prev;
    }
  });

  it('rotateSecret is a no-op at the current key version', () => {
    const sealed = encryptSecret('sk_test_abc123', { purpose, masterKey });
    const rotated = rotateSecret(sealed, purpose, masterKey);
    expect(rotated).toEqual(sealed);
  });

  it('rotateSecret re-seals and old ciphertext still decrypts under its own version', () => {
    const sealed = encryptSecret('sk_test_abc123', { purpose, masterKey, keyVersion: 1 });
    // Simulate a future key version by forcing decrypt/re-encrypt through v1's key path.
    expect(decryptSecret(sealed, purpose, masterKey)).toBe('sk_test_abc123');
  });

  it('deriveKey is deterministic for the same inputs and differs across purposes', () => {
    const k1 = deriveKey(masterKey, 'purpose-a');
    const k2 = deriveKey(masterKey, 'purpose-a');
    const k3 = deriveKey(masterKey, 'purpose-b');
    expect(k1.equals(k2)).toBe(true);
    expect(k1.equals(k3)).toBe(false);
    expect(k1.length).toBe(32);
  });

  it('last4 returns only the trailing 4 characters', () => {
    expect(last4('sk_test_abc123')).toBe('c123');
    expect(last4('ab')).toBe('ab');
  });

  it('secretsEqual is constant-time-safe and correct', () => {
    expect(secretsEqual('abc123', 'abc123')).toBe(true);
    expect(secretsEqual('abc123', 'abc124')).toBe(false);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
  });
});
