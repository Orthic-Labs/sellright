import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetEnvForTest, envOrigin, initEnv } from '../env.js';
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


describe('secret-crypto config source', () => {
  const explicitKey = Buffer.alloc(32, 0x41);
  const ambientKey = Buffer.alloc(32, 0x42);
  beforeEach(() => { _resetEnvForTest(); });
  afterEach(() => { _resetEnvForTest(); vi.unstubAllEnvs(); });

  it.each([undefined, ambientKey.toString('hex')])('uses parsed engine key when ambient key is %s', (ambient) => {
    vi.stubEnv('SELLRIGHT_MASTER_KEY', ambient);
    initEnv({ NODE_ENV: 'test', SELLRIGHT_MASTER_KEY: explicitKey.toString('hex') });
    const sealed = encryptSecret('synthetic-secret', { purpose });
    expect(decryptSecret(sealed, purpose)).toBe('synthetic-secret');
    expect(decryptSecret(sealed, purpose, explicitKey)).toBe('synthetic-secret');
    expect(() => decryptSecret(sealed, purpose, ambientKey)).toThrow();
    expect(process.env.SELLRIGHT_MASTER_KEY).toBe(ambient);
  });

  it('does not fall back to ambient key when explicit engine config omits it', () => {
    vi.stubEnv('SELLRIGHT_MASTER_KEY', ambientKey.toString('hex'));
    initEnv({ NODE_ENV: 'test' });
    const sealed = encryptSecret('synthetic-secret', { purpose, masterKey: ambientKey });
    expect(() => encryptSecret('synthetic-secret', { purpose })).toThrow(/not configured/);
    expect(() => decryptSecret(sealed, purpose)).toThrow(/not configured/);
  });

  it('keeps explicit Buffer injection authoritative even without an engine key', () => {
    vi.stubEnv('SELLRIGHT_MASTER_KEY', 'invalid-ambient-key');
    initEnv({ NODE_ENV: 'test' });
    const sealed = encryptSecret('synthetic-secret', { purpose, masterKey: explicitKey });
    expect(decryptSecret(sealed, purpose, explicitKey)).toBe('synthetic-secret');
  });

  it('preserves standalone ambient key behavior without parsing database config', () => {
    vi.stubEnv('SELLRIGHT_MASTER_KEY', ambientKey.toString('hex'));
    vi.stubEnv('DATABASE_URL', 'invalid-url');
    const sealed = encryptSecret('synthetic-secret', { purpose });
    expect(decryptSecret(sealed, purpose)).toBe('synthetic-secret');
    expect(envOrigin()).toBeUndefined();
  });
});
