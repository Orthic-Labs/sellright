import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetEnvForTest, envOrigin, initEnv } from '../env.js';
import { decryptSecret, type EncryptedSecret } from '../security/secret-crypto.js';
import { isSealedTotpSecret, openTotpSecret, sealLegacyTotpSecrets, sealTotpSecret } from './totp-secret.js';
import { unsafeUnscopedDb as db } from '../db/client.js';

vi.mock('../db/client.js', () => ({ unsafeUnscopedDb: { select: vi.fn() } }));
vi.mock('../lib/logger.js', () => ({ log: { info: vi.fn() } }));

const adminId = 'synthetic-admin';
const secret = 'JBSWY3DPEHPK3PXP';
const explicitKey = Buffer.alloc(32, 0x41);
const ambientKey = Buffer.alloc(32, 0x42);

beforeEach(() => { _resetEnvForTest(); vi.clearAllMocks(); });
afterEach(() => { _resetEnvForTest(); vi.unstubAllEnvs(); });

describe('TOTP secret config source', () => {
  it.each([undefined, ambientKey.toString('hex')])('seals using parsed engine key when ambient key is %s', (ambient) => {
    vi.stubEnv('SELLRIGHT_MASTER_KEY', ambient);
    initEnv({ NODE_ENV: 'test', SELLRIGHT_MASTER_KEY: explicitKey.toString('hex') });
    const stored = sealTotpSecret(adminId, secret);
    expect(isSealedTotpSecret(stored)).toBe(true);
    expect(openTotpSecret(adminId, stored)).toBe(secret);
    const sealed = JSON.parse(Buffer.from(stored.slice('enc1:'.length), 'base64url').toString('utf8')) as EncryptedSecret;
    expect(decryptSecret(sealed, `admin:${adminId}:totp`, explicitKey)).toBe(secret);
    expect(() => openTotpSecret('another-admin', stored)).toThrow();
    expect(process.env.SELLRIGHT_MASTER_KEY).toBe(ambient);
  });

  it('honors explicit missing key instead of borrowing ambient key', async () => {
    vi.stubEnv('SELLRIGHT_MASTER_KEY', ambientKey.toString('hex'));
    initEnv({ NODE_ENV: 'test', SELLRIGHT_MASTER_KEY: ambientKey.toString('hex') });
    const stored = sealTotpSecret(adminId, secret);
    initEnv({ NODE_ENV: 'test' });
    expect(sealTotpSecret(adminId, secret)).toBe(secret);
    expect(() => openTotpSecret(adminId, stored)).toThrow(/not configured/);
    expect(await sealLegacyTotpSecrets()).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('preserves standalone ambient sealing without parsing database config', () => {
    vi.stubEnv('SELLRIGHT_MASTER_KEY', ambientKey.toString('hex'));
    vi.stubEnv('DATABASE_URL', 'invalid-url');
    const stored = sealTotpSecret(adminId, secret);
    expect(isSealedTotpSecret(stored)).toBe(true);
    expect(openTotpSecret(adminId, stored)).toBe(secret);
    expect(envOrigin()).toBeUndefined();
  });

  it('preserves standalone plaintext behavior without a master key', async () => {
    vi.stubEnv('SELLRIGHT_MASTER_KEY', undefined);
    vi.stubEnv('DATABASE_URL', 'invalid-url');
    expect(sealTotpSecret(adminId, secret)).toBe(secret);
    expect(openTotpSecret(adminId, secret)).toBe(secret);
    expect(openTotpSecret(adminId, null)).toBeNull();
    expect(await sealLegacyTotpSecrets()).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
    expect(envOrigin()).toBeUndefined();
  });
});
