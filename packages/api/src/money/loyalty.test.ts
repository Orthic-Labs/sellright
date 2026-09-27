import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOYALTY_SETTINGS, centsToPoints, earnableCents, loyaltySettingsFromConfig, planRedemption,
  pointsEarned, pointsToCents, proportionalTarget, unpostedExpiredPoints, type LoyaltySettings,
} from './loyalty.js';
import { calculateOrderTotals } from './totals.js';

const on: LoyaltySettings = { ...DEFAULT_LOYALTY_SETTINGS, enabled: true, earnRatePerDollar: 2, pointsPerDollarOff: 100 };

describe('loyalty settings', () => {
  it('defaults to a disabled program', () => {
    expect(loyaltySettingsFromConfig(null).enabled).toBe(false);
    expect(loyaltySettingsFromConfig({}).enabled).toBe(false);
  });
  it('fails closed on a malformed block', () => {
    expect(loyaltySettingsFromConfig({ loyalty: { enabled: true, pointsPerDollarOff: 0 } }).enabled).toBe(false);
    expect(loyaltySettingsFromConfig({ loyalty: { enabled: 'yes' } }).enabled).toBe(false);
  });
  it('merges a partial block over defaults', () => {
    const cfg = loyaltySettingsFromConfig({ loyalty: { enabled: true, earnRatePerDollar: 5 } });
    expect(cfg).toMatchObject({ enabled: true, earnRatePerDollar: 5, pointsPerDollarOff: 100, expiryDays: null });
  });
});

describe('earn math', () => {
  it('floors partial points', () => {
    expect(pointsEarned(1999, 1)).toBe(19);
    expect(pointsEarned(1999, 2)).toBe(39);
    expect(pointsEarned(0, 5)).toBe(0);
    expect(pointsEarned(1000, 0)).toBe(0);
  });
  it('earns on merchandise after discounts, excluding included tax', () => {
    expect(earnableCents({ subtotal: 10000, discountTotal: 2000, taxRate: 0, taxInclusive: false })).toBe(8000);
    // 10% inclusive: 11000 gross → 10000 net
    expect(earnableCents({ subtotal: 11000, discountTotal: 0, taxRate: 1000, taxInclusive: true })).toBe(10000);
  });
});

describe('redemption plan', () => {
  it('converts points to cents and charges only what the discount costs', () => {
    expect(pointsToCents(250, 100)).toBe(250);
    expect(centsToPoints(250, 100)).toBe(250);
    const plan = planRedemption({ settings: on, requestedPoints: 500, availablePoints: 500, discountableCents: 10000 });
    expect(plan).toEqual({ ok: true, points: 500, discountCents: 500 });
  });
  it('caps the discount at maxRedeemPercentOfSubtotal and spends fewer points', () => {
    const plan = planRedemption({ settings: { ...on, maxRedeemPercentOfSubtotal: 10 }, requestedPoints: 5000, availablePoints: 5000, discountableCents: 10000 });
    expect(plan).toEqual({ ok: true, points: 1000, discountCents: 1000 });
  });
  it('never discounts below zero', () => {
    const plan = planRedemption({ settings: on, requestedPoints: 5000, availablePoints: 5000, discountableCents: 1234 });
    expect(plan).toEqual({ ok: true, points: 1234, discountCents: 1234 });
  });
  it('rejects instead of clamping above the balance', () => {
    expect(planRedemption({ settings: on, requestedPoints: 600, availablePoints: 500, discountableCents: 10000 }))
      .toEqual({ ok: false, reason: 'insufficient_balance' });
  });
  it('enforces the minimum and the enabled flag', () => {
    expect(planRedemption({ settings: { ...on, minRedeemPoints: 1000 }, requestedPoints: 500, availablePoints: 5000, discountableCents: 10000 }))
      .toEqual({ ok: false, reason: 'below_minimum' });
    expect(planRedemption({ settings: { ...on, enabled: false }, requestedPoints: 500, availablePoints: 5000, discountableCents: 10000 }))
      .toEqual({ ok: false, reason: 'disabled' });
  });
  it('handles a points rate that does not divide evenly', () => {
    // 3 points per $1 → 10 points buy 333 cents; 333 cents cost 10 points.
    expect(planRedemption({ settings: { ...on, pointsPerDollarOff: 3 }, requestedPoints: 10, availablePoints: 10, discountableCents: 10000 }))
      .toEqual({ ok: true, points: 10, discountCents: 333 });
  });
});

describe('proportional reversal', () => {
  it('converges to the full amount with no drift across partial refunds', () => {
    const total = 101;
    const t1 = proportionalTarget(total, 1000, 3000);
    const t2 = proportionalTarget(total, 2000, 3000);
    const t3 = proportionalTarget(total, 3000, 3000);
    expect([t1, t2, t3]).toEqual([34, 67, 101]);
    expect(proportionalTarget(total, 5000, 3000)).toBe(101);
    expect(proportionalTarget(total, 0, 3000)).toBe(0);
  });
});

describe('FIFO expiry', () => {
  const d = (day: number) => new Date(Date.UTC(2026, 0, day));
  it('expires unspent points from expired lots only', () => {
    const entries = [
      { kind: 'earn', points: 100, expiresAt: d(10), createdAt: d(1) },
      { kind: 'earn', points: 50, expiresAt: d(30), createdAt: d(2) },
      { kind: 'redeem', points: -30, expiresAt: null, createdAt: d(3) },
    ];
    // redeem consumed the soonest-expiring lot first → 70 left in lot 1
    expect(unpostedExpiredPoints(entries, d(5))).toBe(0);
    expect(unpostedExpiredPoints(entries, d(11))).toBe(70);
    expect(unpostedExpiredPoints(entries, d(31))).toBe(120);
  });
  it('an expire posting writes off the expired lots', () => {
    const entries = [
      { kind: 'earn', points: 100, expiresAt: d(10), createdAt: d(1) },
      { kind: 'adjust', points: 40, expiresAt: null, createdAt: d(2) },
      { kind: 'expire', points: -100, expiresAt: null, createdAt: d(11) },
    ];
    expect(unpostedExpiredPoints(entries, d(12))).toBe(0);
  });
  it('never-expiring lots never expire', () => {
    expect(unpostedExpiredPoints([{ kind: 'import', points: 500, expiresAt: null, createdAt: d(1) }], d(365))).toBe(0);
  });
});

describe('totals with a points discount', () => {
  it('applies after the promotion and before tax', () => {
    const t = calculateOrderTotals({
      lines: [{ unitPrice: 6000, quantity: 1 }, { unitPrice: 4000, quantity: 1 }],
      shipping: 500, taxRate: 1000, promotion: { type: 'percentage', value: 10 }, pointsDiscount: 1000,
    });
    // 10000 − 1000 promo − 1000 points = 8000; tax 10% = 800; + 500 shipping
    expect(t.discountTotal).toBe(2000);
    expect(t.pointsDiscount).toBe(1000);
    expect(t.taxTotal).toBe(800);
    expect(t.grandTotal).toBe(9300);
    expect(t.lines.reduce((n, l) => n + l.lineDiscount, 0)).toBe(2000);
  });
  it('is capped at the remaining merchandise subtotal', () => {
    const t = calculateOrderTotals({ lines: [{ unitPrice: 500, quantity: 1 }], shipping: 0, taxRate: 0, pointsDiscount: 9999 });
    expect(t.pointsDiscount).toBe(500);
    expect(t.grandTotal).toBe(0);
  });
  it('is a no-op when absent', () => {
    const t = calculateOrderTotals({ lines: [{ unitPrice: 500, quantity: 2 }], shipping: 0, taxRate: 0 });
    expect(t.pointsDiscount).toBe(0);
    expect(t.discountTotal).toBe(0);
  });
});
