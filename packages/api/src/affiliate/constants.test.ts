import { describe, expect, it } from 'vitest';
import { AFFILIATE_MIN_TOKEN_LENGTH, AFFILIATE_ORDER_LIMIT, AFFILIATE_STATS_RATE, AFFILIATE_TOP_SELLERS, COMMISSION_PCT, COMMISSION_STATES, commissionBasis, commissionOf } from './constants.js';
import { newAffiliateToken } from './onboarding.js';

describe('affiliate commission rules (DD parity)', () => {
  it('commissions the net basis: subtotal minus discount, never negative', () => {
    expect(commissionBasis({ subtotal: 4000, discountTotal: 600 })).toBe(3400);
    expect(commissionBasis({ subtotal: 1000, discountTotal: 1500 })).toBe(0);
    expect(Math.round(commissionBasis({ subtotal: 4000, discountTotal: 600 }) * (COMMISSION_PCT / 100))).toBe(340);
  });

  it('counts only paid states', () => {
    expect([...COMMISSION_STATES]).toEqual(['Paid', 'PartiallyRefunded']);
  });

  it('matches the previous platform public limits', () => {
    expect(AFFILIATE_ORDER_LIMIT).toBe(500);
    expect(AFFILIATE_TOP_SELLERS).toBe(3);
    expect(AFFILIATE_STATS_RATE).toEqual({ windowMs: 60_000, max: 30 });
    expect(AFFILIATE_MIN_TOKEN_LENGTH).toBe(16);
  });

  it('issues tokens well above the minimum length', () => {
    expect(newAffiliateToken().length).toBeGreaterThanOrEqual(AFFILIATE_MIN_TOKEN_LENGTH);
  });

  it('audit M-M5: 10000 order with 9000 merchandise refunded earns 100, not 1000', () => {
    const basis = commissionBasis({ subtotal: 10000, discountTotal: 0, refundedMerchandise: 9000 });
    expect(basis).toBe(1000);
    expect(commissionOf(basis, COMMISSION_PCT)).toBe(100);
  });

  it('refunds beyond the net basis floor the basis at 0', () => {
    expect(commissionBasis({ subtotal: 4000, discountTotal: 600, refundedMerchandise: 3400 })).toBe(0);
    expect(commissionBasis({ subtotal: 4000, discountTotal: 600, refundedMerchandise: 5000 })).toBe(0);
  });

  it('audit M-L6: three orders of 1005 earn 101 each = 303 (per-order rounding, half up), not 302', () => {
    expect(commissionOf(1005, 10)).toBe(101);
    expect([1005, 1005, 1005].reduce((n, b) => n + commissionOf(b, COMMISSION_PCT), 0)).toBe(303);
  });

  it('commissionOf stays integer-exact where float multiplication drifts', () => {
    expect(commissionOf(1005, 10)).toBe(101);
    expect(commissionOf(1004, 10)).toBe(100);
    expect(commissionOf(0, 10)).toBe(0);
  });
});
