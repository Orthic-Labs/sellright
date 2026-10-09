import { describe, expect, it } from 'vitest';
import { toLoyaltyForm, validateLoyaltyForm } from './loyalty-form';

const base = {
  enabled: true, earnRatePerDollar: 1, pointsPerDollarOff: 10, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: null, expiryDays: null,
  reviewBonusPoints: 25, reviewBonusVerifiedOnly: true, signupBonusPoints: 0, signupBonusSince: null,
  firstOrderBonusPoints: 0, birthdayBonusPoints: 0, productMultipliers: [] as Array<{ productId: string; multiplier: number }>,
};

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
  it('round-trips bonus rules and product multipliers', () => {
    const s = { ...base, signupBonusPoints: 100, signupBonusSince: '2026-10-09T00:00:00.000Z', productMultipliers: [{ productId: 'p1', multiplier: 2.5 }] };
    expect(validateLoyaltyForm(toLoyaltyForm(s))).toEqual({ settings: s });
  });
  it('rejects bad bonus amounts and multipliers', () => {
    expect(validateLoyaltyForm({ ...toLoyaltyForm(base), reviewBonusPoints: '-5' }).error).toMatch(/Review bonus/);
    expect(validateLoyaltyForm({ ...toLoyaltyForm(base), birthdayBonusPoints: '1.5' }).error).toMatch(/Birthday/);
    expect(validateLoyaltyForm({ ...toLoyaltyForm(base), productMultipliers: [{ productId: 'p', multiplier: '0.5' }] }).error).toMatch(/multiplier/);
  });
});
