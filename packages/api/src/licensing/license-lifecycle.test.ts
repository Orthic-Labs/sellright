import { describe, expect, it } from 'vitest';
import { planLicenseLifecycle } from './license-lifecycle.js';

const issuedAt = new Date('2026-07-01T00:00:00.000Z');

describe('signed license lifecycle', () => {
  it('clamps a trial token to the server-issued hard expiry', () => {
    const expiresAt = new Date('2026-07-15T00:00:00.000Z');
    expect(planLicenseLifecycle({
      createdAt: issuedAt,
      expiresAt,
      metadata: { kind: 'trial' },
    }, new Date('2026-07-02T00:00:00.000Z'))).toEqual({
      licenseKind: 'trial',
      entitlementStage: 'time_bound',
      licenseIssuedAtUnix: 1_782_864_000,
      confirmationDueAtUnix: null,
      tokenExpiresAtUnix: 1_784_073_600,
      validUntil: expiresAt,
    });
  });

  it('issues a lifetime purchase provisionally until the fixed confirmation boundary', () => {
    const due = new Date('2026-07-31T00:00:00.000Z');
    expect(planLicenseLifecycle({
      createdAt: issuedAt,
      expiresAt: null,
      metadata: { tier: 'pro' },
    }, new Date('2026-07-20T00:00:00.000Z'))).toEqual({
      licenseKind: 'lifetime',
      entitlementStage: 'provisional',
      licenseIssuedAtUnix: 1_782_864_000,
      confirmationDueAtUnix: 1_785_456_000,
      tokenExpiresAtUnix: 1_785_456_000,
      validUntil: due,
    });
  });

  it('issues the final offline lifetime entitlement only after the online check', () => {
    expect(planLicenseLifecycle({
      createdAt: issuedAt,
      expiresAt: null,
      metadata: { tier: 'pro' },
    }, new Date('2026-07-31T00:00:00.000Z'))).toEqual({
      licenseKind: 'lifetime',
      entitlementStage: 'final',
      licenseIssuedAtUnix: 1_782_864_000,
      confirmationDueAtUnix: 1_785_456_000,
      tokenExpiresAtUnix: 253_402_300_799,
      validUntil: null,
    });
  });

  it('keeps non-trial term licenses time-bound with a rolling token window', () => {
    const expiresAt = new Date('2027-07-01T00:00:00.000Z');
    expect(planLicenseLifecycle({
      createdAt: issuedAt,
      expiresAt,
      metadata: { tier: 'pro' },
    }, new Date('2026-07-02T00:00:00.000Z'))).toMatchObject({
      licenseKind: 'term',
      entitlementStage: 'time_bound',
      confirmationDueAtUnix: null,
      tokenExpiresAtUnix: 1_785_542_400, // now + 30d rolling
      validUntil: expiresAt,
    });
  });

  it('accepts configured windows instead of the defaults', () => {
    expect(planLicenseLifecycle({
      createdAt: issuedAt,
      expiresAt: null,
      metadata: {},
    }, new Date('2026-07-08T00:00:00.000Z'), { lifetimeConfirmationDays: 7 })).toMatchObject({
      licenseKind: 'lifetime',
      entitlementStage: 'final',
      confirmationDueAtUnix: 1_782_864_000 + 7 * 86_400,
    });
  });
});
