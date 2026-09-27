import { describe, expect, it } from 'vitest';
import { toLoyaltyForm, validateLoyaltyForm } from './loyalty-form';

const base = { enabled: true, earnRatePerDollar: 1, pointsPerDollarOff: 100, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: null, expiryDays: null };

describe('loyalty settings form', () => {
  it('round-trips settings, blanks meaning "no cap" / "never"', () => {
    expect(validateLoyaltyForm(toLoyaltyForm(base))).toEqual({ settings: base });
  });
  it('rejects out-of-range values', () => {
    expect(validateLoyaltyForm({ ...toLoyaltyForm(base), pointsPerDollarOff: '0' }).error).toMatch(/≥ 1/);
    expect(validateLoyaltyForm({ ...toLoyaltyForm(base), maxRedeemPercentOfSubtotal: '150' }).error).toMatch(/1–100/);
    expect(validateLoyaltyForm({ ...toLoyaltyForm(base), expiryDays: '1.5' }).error).toMatch(/days/);
    expect(validateLoyaltyForm({ ...toLoyaltyForm(base), earnRatePerDollar: '' }).error).toMatch(/earned/);
  });
});
