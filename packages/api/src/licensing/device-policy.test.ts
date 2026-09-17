import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDevicePolicies,
  derivePool,
  devicePolicyFor,
  hasCurrentDevicePolicy,
  isKnownPlatform,
  leasablePool,
  poolCap,
  registerDevicePolicy,
  usesBoundedDevicePools,
  withCurrentDevicePolicy,
  activationSourceDefaults,
  leaseGraceSecondsFor,
  leaseTtlSecondsFor,
} from './device-policy.js';

const TEST_POLICY = {
  marker: 'testapp_2c_2m_v1',
  poolCaps: { computer: 2, mobile: 2 },
  pooledSeats: true,
} as const;

afterEach(() => clearDevicePolicies());

describe('device policy registry', () => {
  it('marks new licenses for a registered app without discarding metadata', () => {
    registerDevicePolicy('testapp', TEST_POLICY);
    expect(withCurrentDevicePolicy('testapp', { tier: 'pro' })).toEqual({
      tier: 'pro',
      device_policy: TEST_POLICY.marker,
    });
  });

  it('keeps an unmarked seats=0 license grandfathered unlimited', () => {
    registerDevicePolicy('testapp', TEST_POLICY);
    expect(usesBoundedDevicePools('testapp', 0, { tier: 'pro' })).toBe(false);
  });

  it('bounds new seats=0 licenses and older positive-seat licenses', () => {
    registerDevicePolicy('testapp', TEST_POLICY);
    const marked = withCurrentDevicePolicy('testapp', { tier: 'pro' });
    expect(hasCurrentDevicePolicy('testapp', marked)).toBe(true);
    expect(usesBoundedDevicePools('testapp', 0, marked)).toBe(true);
    expect(usesBoundedDevicePools('testapp', 2, null)).toBe(true);
  });

  it('does not change an unregistered app', () => {
    expect(devicePolicyFor('otherapp')).toBeNull();
    expect(withCurrentDevicePolicy('otherapp', { tier: 'pro' })).toEqual({ tier: 'pro' });
    expect(usesBoundedDevicePools('otherapp', 2, null)).toBe(false);
    expect(poolCap('otherapp', 'computer')).toBe(Number.POSITIVE_INFINITY);
  });

  it('pool caps come from the registered policy, never a hardcoded constant', () => {
    registerDevicePolicy('capped', { marker: 'm1', poolCaps: { computer: 3 } });
    expect(poolCap('capped', 'computer')).toBe(3);
    expect(poolCap('capped', 'mobile')).toBe(Number.POSITIVE_INFINITY);
    expect(poolCap('capped', 'companion')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('pool derivation', () => {
  it('pools desktop OSes as computer, mobile OSes as mobile, watch as companion', () => {
    expect(derivePool('anyapp', 'macos')).toBe('computer');
    expect(derivePool('anyapp', 'windows')).toBe('computer');
    expect(derivePool('anyapp', 'linux')).toBe('computer');
    expect(derivePool('anyapp', 'ios')).toBe('mobile');
    expect(derivePool('anyapp', 'ipados')).toBe('mobile');
    expect(derivePool('anyapp', 'android')).toBe('mobile');
    expect(derivePool('anyapp', 'watchos')).toBe('companion');
  });

  it('returns null for an unknown platform', () => {
    expect(derivePool('anyapp', 'toasteros')).toBeNull();
    expect(isKnownPlatform('toasteros')).toBe(false);
    expect(isKnownPlatform('macos')).toBe(true);
  });

  it('honors a per-app platformPools override and extended platforms', () => {
    registerDevicePolicy('tvapp', {
      marker: 'tv1',
      poolCaps: { living_room: 4 },
      platformPools: { tvos: 'living_room', macos: 'computer' },
      leasablePools: ['living_room', 'computer'],
    });
    expect(derivePool('tvapp', 'tvos')).toBe('living_room');
    expect(derivePool('tvapp', 'macos')).toBe('computer');
    expect(poolCap('tvapp', 'living_room')).toBe(4);
  });
});

describe('leasable pools', () => {
  it('defaults to computer+mobile so companion devices can never claim a lease', () => {
    registerDevicePolicy('testapp', TEST_POLICY);
    expect(leasablePool('testapp', 'computer')).toBe(true);
    expect(leasablePool('testapp', 'mobile')).toBe(true);
    expect(leasablePool('testapp', 'companion')).toBe(false);
    // No policy at all still rejects the companion pool — a modified client can
    // never dodge a seat by claiming a companion platform.
    expect(leasablePool('unregistered', 'companion')).toBe(false);
  });
});

describe('lease windows + activation sources', () => {
  it('uses policy lease windows with generic defaults', () => {
    expect(leaseTtlSecondsFor('none')).toBe(7 * 86_400);
    expect(leaseGraceSecondsFor('none')).toBe(14 * 86_400);
    registerDevicePolicy('short', { marker: 's1', leaseTtlSeconds: 60, leaseGraceSeconds: 120 });
    expect(leaseTtlSecondsFor('short')).toBe(60);
    expect(leaseGraceSecondsFor('short')).toBe(120);
  });

  it('maps a trusted activation source to class+pool only under a registered policy', () => {
    expect(activationSourceDefaults('unregistered', 'desktop')).toBeNull();
    registerDevicePolicy('testapp', TEST_POLICY);
    expect(activationSourceDefaults('testapp', 'desktop')).toEqual({ deviceClass: 'desktop', pool: 'computer' });
    registerDevicePolicy('mobileapp', {
      marker: 'm',
      activationSources: { desktop: { deviceClass: 'mac', pool: 'computer' }, storekit: { deviceClass: 'iphone', pool: 'mobile' } },
    });
    expect(activationSourceDefaults('mobileapp', 'storekit')).toEqual({ deviceClass: 'iphone', pool: 'mobile' });
  });
});
