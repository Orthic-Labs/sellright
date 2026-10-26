import { describe, expect, it } from 'vitest';
import { AFFILIATE_MIN_TOKEN_LENGTH, AFFILIATE_ORDER_LIMIT, AFFILIATE_STATS_RATE, AFFILIATE_TOP_SELLERS, COMMISSION_PCT, COMMISSION_STATES, commissionBasis } from './constants.js';
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
});
