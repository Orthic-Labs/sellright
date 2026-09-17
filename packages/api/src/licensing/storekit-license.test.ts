import { describe, expect, it } from 'vitest';
import { storeKitLicenseKey, isSandboxStoreKitLicense } from './storekit-license.js';

describe('storeKitLicenseKey', () => {
  it('is stable for one verified purchase', () => {
    const source = { originalTransactionId: '2000001', bundleId: 'app.example.ios', environment: 'Production' };
    expect(storeKitLicenseKey('example', source)).toBe(storeKitLicenseKey('example', source));
  });

  it('isolates Sandbox from Production even when Apple transaction ids match', () => {
    const base = { originalTransactionId: '2000001', bundleId: 'app.example.ios' };
    expect(storeKitLicenseKey('example', { ...base, environment: 'Sandbox' }))
      .not.toBe(storeKitLicenseKey('example', { ...base, environment: 'Production' }));
  });

  it('isolates app keys so the same purchase cannot collide across apps', () => {
    const source = { originalTransactionId: '2000001', bundleId: 'app.example.ios', environment: 'Production' };
    expect(storeKitLicenseKey('example-a', source)).not.toBe(storeKitLicenseKey('example-b', source));
  });
});

describe('isSandboxStoreKitLicense', () => {
  it('flags only Sandbox-origin StoreKit licenses', () => {
    expect(isSandboxStoreKitLicense({ storekit_environment: 'Sandbox' })).toBe(true);
    expect(isSandboxStoreKitLicense({ storekit_environment: 'Production' })).toBe(false);
    expect(isSandboxStoreKitLicense({})).toBe(false);
    expect(isSandboxStoreKitLicense(null)).toBe(false);
    expect(isSandboxStoreKitLicense('Sandbox')).toBe(false);
  });
});
