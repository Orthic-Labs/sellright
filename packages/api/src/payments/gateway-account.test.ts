import { describe, expect, it } from 'vitest';
import { gatewayAccount, nmiEnvironment, gatewayIdentity, assertGatewayEnvironment } from './gateway-account.js';

const storeId = '00000000-0000-4000-8000-000000000001';
const base = { accountId: 'nmi-test', storeId, method: 'nmi', mode: 'test', securityKey: 'fixture' };
const resolve = (changes: Record<string, unknown> = {}) =>
  gatewayAccount(storeId, 'nmi', 'nmi-test', undefined, JSON.stringify([{ ...base, ...changes }]));

describe('NMI environment selection', () => {
  it('rejects environment rotation for an already recorded payment', () => {
    const original = gatewayIdentity(resolve());
    expect(() => assertGatewayEnvironment(resolve({ nmiEnvironment: 'production' }), original)).toThrow();
    expect(() => assertGatewayEnvironment(resolve({ nmiEnvironment: 'production' }), null)).toThrow();
    const productionTest = resolve({ nmiEnvironment: 'production' });
    expect(() => assertGatewayEnvironment(productionTest, gatewayIdentity(productionTest))).not.toThrow();
  });
  it('preserves existing sandbox defaults', () => {
    expect(nmiEnvironment(resolve())).toBe('sandbox');
  });
  it('supports test transactions on an existing merchant account', () => {
    expect(nmiEnvironment(resolve({ nmiEnvironment: 'production' }))).toBe('production');
    expect(resolve({ nmiEnvironment: 'production' }).mode).toBe('test');
  });
  it('rejects a sandbox endpoint labeled live', () => {
    expect(() => resolve({ mode: 'live', nmiEnvironment: 'sandbox' })).toThrow();
  });
  it('rejects arbitrary endpoint URLs', () => {
    expect(() => resolve({ nmiEnvironment: 'https://untrusted.invalid' })).toThrow();
  });
});
