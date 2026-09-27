import { describe, expect, it, vi } from 'vitest';
import { resolveField, isEnvManaged, type FieldScope } from './settings-resolver.js';
import { encryptSecret } from './secret-crypto.js';
import type { Tx } from '../db/client.js';

const scope: FieldScope = { storeId: '11111111-1111-1111-1111-111111111111', provider: 'stripe', mode: 'test', field: 'secretKey' };

function fakeDb(rows: unknown[]): Tx {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain as unknown as Tx;
}

describe('settings-resolver: env>db precedence', () => {
  it('returns the env value and source=env, without touching the database', async () => {
    const db = fakeDb([{ /* would blow up if selected */ }]);
    const selectSpy = vi.spyOn(db, 'select');
    const result = await resolveField(db, scope, 'sk_test_env_value');
    expect(result).toEqual({ value: 'sk_test_env_value', source: 'env' });
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('falls back to the database and decrypts when env is undefined', async () => {
    const purpose = `store:${scope.storeId}:${scope.provider}:${scope.mode}:${scope.field}`;
    const sealed = encryptSecret('sk_test_db_value', { purpose, masterKey: Buffer.alloc(32, 7) });
    process.env.SELLRIGHT_MASTER_KEY = Buffer.alloc(32, 7).toString('hex');
    try {
      const db = fakeDb([{ keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag }]);
      const result = await resolveField(db, scope, undefined);
      expect(result).toEqual({ value: 'sk_test_db_value', source: 'db' });
    } finally {
      delete process.env.SELLRIGHT_MASTER_KEY;
    }
  });

  it('falls back to the database when env is an empty string', async () => {
    const purpose = `store:${scope.storeId}:${scope.provider}:${scope.mode}:${scope.field}`;
    const sealed = encryptSecret('sk_test_db_value', { purpose, masterKey: Buffer.alloc(32, 7) });
    process.env.SELLRIGHT_MASTER_KEY = Buffer.alloc(32, 7).toString('hex');
    try {
      const db = fakeDb([{ keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag }]);
      const result = await resolveField(db, scope, '');
      expect(result.source).toBe('db');
    } finally {
      delete process.env.SELLRIGHT_MASTER_KEY;
    }
  });

  it('returns source=unset when neither env nor db has the field', async () => {
    const db = fakeDb([]);
    const result = await resolveField(db, scope, undefined);
    expect(result).toEqual({ value: '', source: 'unset' });
  });

  it('a value scoped to a different store never decrypts under this store\'s scope', async () => {
    const otherPurpose = 'store:22222222-2222-2222-2222-222222222222:stripe:test:secretKey';
    const sealed = encryptSecret('sk_test_belongs_to_other_store', { purpose: otherPurpose, masterKey: Buffer.alloc(32, 7) });
    process.env.SELLRIGHT_MASTER_KEY = Buffer.alloc(32, 7).toString('hex');
    try {
      const db = fakeDb([{ keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag }]);
      await expect(resolveField(db, scope, undefined)).rejects.toThrow();
    } finally {
      delete process.env.SELLRIGHT_MASTER_KEY;
    }
  });
});

describe('isEnvManaged', () => {
  it('true for a non-empty env value', () => expect(isEnvManaged('x')).toBe(true));
  it('false for undefined or empty', () => {
    expect(isEnvManaged(undefined)).toBe(false);
    expect(isEnvManaged('')).toBe(false);
  });
});
