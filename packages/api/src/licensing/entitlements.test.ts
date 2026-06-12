import { describe, expect, it } from 'vitest';
import { buildLicenseGrants, canAccessDownload, canReceiveUpdate } from './entitlements.js';

describe('license entitlement planning', () => {
  it('issues one license per purchased software seat and carries update eligibility', () => {
    const grants = buildLicenseGrants([
      {
        orderLineId: 'line-1',
        quantity: 2,
        fulfillmentType: 'license',
        appKey: 'viewright',
        licenseSeats: 1,
        updatesDurationDays: 365,
        licenseDurationDays: null,
        metadata: { tier: 'pro' },
      },
      {
        orderLineId: 'line-2',
        quantity: 1,
        fulfillmentType: 'physical',
        appKey: null,
        licenseSeats: null,
        updatesDurationDays: null,
        licenseDurationDays: null,
        metadata: null,
      },
    ], new Date('2026-06-12T00:00:00Z'));

    expect(grants).toEqual([
      {
        orderLineId: 'line-1',
        appKey: 'viewright',
        seats: 1,
        expiresAt: null,
        updatesUntil: new Date('2027-06-12T00:00:00Z'),
        metadata: { tier: 'pro' },
      },
      {
        orderLineId: 'line-1',
        appKey: 'viewright',
        seats: 1,
        expiresAt: null,
        updatesUntil: new Date('2027-06-12T00:00:00Z'),
        metadata: { tier: 'pro' },
      },
    ]);
  });

  it('issues download entitlements for digital download variants', () => {
    const grants = buildLicenseGrants([
      {
        orderLineId: 'line-download',
        quantity: 1,
        fulfillmentType: 'digital_download',
        appKey: 'viewright',
        licenseSeats: null,
        updatesDurationDays: null,
        licenseDurationDays: null,
        metadata: { artifactKey: 'viewright-windows' },
      },
    ], new Date('2026-06-12T00:00:00Z'));

    expect(grants).toEqual([
      {
        orderLineId: 'line-download',
        appKey: 'viewright',
        seats: 1,
        expiresAt: null,
        updatesUntil: null,
        metadata: { artifactKey: 'viewright-windows' },
      },
    ]);
  });

  it('carries variant device limits onto every generated license key', () => {
    const grants = buildLicenseGrants([
      {
        orderLineId: 'line-five-devices',
        quantity: 2,
        fulfillmentType: 'license',
        appKey: 'viewright',
        licenseSeats: 5,
        updatesDurationDays: 3650,
        licenseDurationDays: 3650,
        metadata: null,
      },
    ], new Date('2026-06-12T00:00:00Z'));

    expect(grants).toHaveLength(2);
    expect(grants.map((grant) => grant.seats)).toEqual([5, 5]);
    expect(grants[0]?.expiresAt).toEqual(new Date('2036-06-09T00:00:00Z'));
  });

  it('allows updates only while the license has update coverage', () => {
    expect(canReceiveUpdate({ status: 'active', updatesUntil: new Date('2026-06-13T00:00:00Z') }, new Date('2026-06-12T00:00:00Z'))).toBe(true);
    expect(canReceiveUpdate({ status: 'active', updatesUntil: new Date('2026-06-11T23:59:59Z') }, new Date('2026-06-12T00:00:00Z'))).toBe(false);
    expect(canReceiveUpdate({ status: 'revoked', updatesUntil: new Date('2026-06-13T00:00:00Z') }, new Date('2026-06-12T00:00:00Z'))).toBe(false);
  });

  it('allows downloads for active unexpired licenses even when update coverage has expired', () => {
    expect(canAccessDownload({ status: 'active', expiresAt: null }, new Date('2026-06-12T00:00:00Z'))).toBe(true);
    expect(canAccessDownload({ status: 'active', expiresAt: new Date('2026-06-13T00:00:00Z') }, new Date('2026-06-12T00:00:00Z'))).toBe(true);
    expect(canAccessDownload({ status: 'active', expiresAt: new Date('2026-06-11T23:59:59Z') }, new Date('2026-06-12T00:00:00Z'))).toBe(false);
    expect(canAccessDownload({ status: 'revoked', expiresAt: null }, new Date('2026-06-12T00:00:00Z'))).toBe(false);
  });
});
