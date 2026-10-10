import { afterEach, describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import {
  ALLOW, DEFAULT_ENTITLEMENT_POLICY, clearEntitlementPolicy, entitlementPolicy, parseRequestExtensions,
  policyClaims, policyLeaseUnlimited, policyTrial, registerEntitlementPolicy,
} from './entitlement-policy.js';
import { TRIAL_DAYS } from './trial.js';

afterEach(() => clearEntitlementPolicy());

describe('entitlement policy registry', () => {
  it('defaults: nothing registered => default policy, no claims, not unlimited, TRIAL_DAYS, no extensions', () => {
    expect(entitlementPolicy()).toBe(DEFAULT_ENTITLEMENT_POLICY);
    expect(policyClaims({ path: 'activate', license: { appKey: 'a', metadata: {} } })).toEqual({});
    expect(policyLeaseUnlimited({ path: 'lease_issue', license: { appKey: 'a', seats: 0, metadata: {} }, pool: 'mobile' })).toBe(false);
    expect(policyTrial({ storeId: 's', appKey: 'a', email: 'e', outcome: 'start', priorMetadata: null, ext: {}, now: new Date() })).toEqual({ days: TRIAL_DAYS });
    expect(parseRequestExtensions('trial', { platform: 'anything' })).toEqual({});
    expect(ALLOW).toEqual({ allow: true });
  });

  it('a registered policy replaces the previous one; clear restores the default', () => {
    registerEntitlementPolicy({ id: 'one' });
    registerEntitlementPolicy({ id: 'two' });
    expect(entitlementPolicy().id).toBe('two');
    clearEntitlementPolicy();
    expect(entitlementPolicy().id).toBe('default');
  });

  it('typed extensions: only declared keys survive; invalid values are a 400', () => {
    registerEntitlementPolicy({ id: 'x', requestExtensions: { trial: z.object({ platform: z.enum(['macos', 'ios']).optional() }) } });
    expect(parseRequestExtensions('trial', { platform: 'macos', evil: 1 })).toEqual({ platform: 'macos' });
    expect(parseRequestExtensions('activate', { platform: 'macos' })).toEqual({});
    expect(() => parseRequestExtensions('trial', { platform: 'beos' })).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_REQUEST' }));
  });

  it('P36-3: default keeps 400 INVALID_REQUEST; a policy that opts into invalidExtension "internal" gets the raw ZodError (legacy 500)', () => {
    const schema = z.object({ platform: z.enum(['macos', 'ios']).optional() });
    registerEntitlementPolicy({ id: 'default-ext', requestExtensions: { trial: schema } });
    expect(() => parseRequestExtensions('trial', { platform: 'beos' })).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_REQUEST' }));
    registerEntitlementPolicy({ id: 'legacy-ext', invalidExtension: 'internal', requestExtensions: { trial: schema } });
    let thrown: unknown;
    try { parseRequestExtensions('trial', { platform: 'beos' }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(z.ZodError);
    expect((thrown as { status?: unknown }).status).toBeUndefined();
  });

  it('extension results are frozen (a decision cannot mutate shared request state)', () => {
    registerEntitlementPolicy({ id: 'x', requestExtensions: { activate: z.object({ deviceClass: z.string().optional() }) } });
    const ext = parseRequestExtensions('activate', { deviceClass: 'mac' }) as Record<string, unknown>;
    expect(() => { ext.deviceClass = 'watch'; }).toThrow();
  });
});
