import { describe, expect, it } from 'vitest';
import { calculateOrderTotals } from './totals.js';
import { calculatePromotionStack, canonicalCouponCodes, prorateSigned, PromotionStackError, type ResolvedPromotion, type StackInput, type StackLine } from './promotion-stack.js';

const line = (patch: Partial<StackLine> = {}): StackLine => ({ key: 'SKU', quantity: 1, placedQuantity: 1,
  unitListPrice: 1000, priceIncludesTax: false, taxRateBps: 0, ...patch });
const promotion = (patch: Partial<ResolvedPromotion> = {}): ResolvedPromotion => ({
  id: 'promo', code: 'SAVE', kind: 'percentage', scope: 'order', value: 10, priority: 0, sequence: 0, freeShipping: false, conditions: [], ...patch,
});
const input = (patch: Partial<StackInput> = {}): StackInput => ({ lines: [line()], promotions: [promotion()], couponCodes: ['SAVE'],
  phase: 'AddingItems', currency: 'USD', pricesIncludeTax: false, shipping: 100, shippingTaxRateBps: 0,
  shippingIncludesTax: false, couponContext: { activeVerifications: [] }, ...patch });
const minimum = (amount: number, taxInclusive = false) => [{ code: 'minimum_order_amount', args: [{ name: 'amount', value: String(amount) }, { name: 'taxInclusive', value: String(taxInclusive) }] }];

describe('captured-default promotion stack', () => {
  it('rounds negative order action before negation; legacy singleton keeps positive rounding', () => {
    expect(calculatePromotionStack(input({ lines: [line({ unitListPrice: 101 })], promotions: [promotion({ value: 50 })] })).discountTotal).toBe(50);
    expect(calculateOrderTotals({ lines: [{ unitPrice: 101, quantity: 1 }], shipping: 0, taxRate: 0, promotion: { type: 'percentage', value: 50 } }).discountTotal).toBe(51);
  });

  it('signed proration conserves cents & resolves ties by input order', () => {
    expect(prorateSigned([1, 1], -1)).toEqual([0, -1]);
    expect(prorateSigned([1, 1, 1], -101)).toEqual([-33, -34, -34]);
    expect(prorateSigned([0, 0], -1)).toEqual([0, -1]);
    expect(prorateSigned([1, 1], 1)).toEqual([1, 0]);
  });

  it('stacks all automatic & explicit promotions by priority, independently of coupon insertion order', () => {
    const result = calculatePromotionStack(input({ couponCodes: ['SECOND', 'FIRST', 'first'], promotions: [
      promotion({ id: 'second', code: 'SECOND', kind: 'fixed', value: 100, priority: 2, sequence: 2 }),
      promotion({ id: 'automatic', code: null, value: 10, priority: 0, sequence: 0 }),
      promotion({ id: 'first', code: 'FIRST', value: 50, priority: 1, sequence: 1 }),
    ] }));
    expect(result.applied.map(entry => [entry.promotionId, entry.amount])).toEqual([['automatic', -100], ['first', -450], ['second', -100]]);
    expect(result.coupons.map(status => status.code)).toEqual(['SECOND', 'FIRST']);
    expect(result.grandTotal).toBe(450);
  });

  it('re-tests later order & shipping actions against current discounted merchandise', () => {
    const result = calculatePromotionStack(input({ promotions: [
      promotion({ id: 'first', value: 50 }),
      promotion({ id: 'minimum', code: null, value: 10, priority: 1, conditions: minimum(600) }),
      promotion({ id: 'combined', code: null, kind: 'fixed', value: 100, priority: 2, freeShipping: true, conditions: minimum(500) }),
    ] }));
    expect(result.applied.map(entry => entry.promotionId)).toEqual(['first', 'combined']);
    expect(result.discountTotal).toBe(600);
    expect(result.shippingTotal).toBe(100);
  });

  it('selects condition net/gross basis independently from channel discount basis', () => {
    const result = calculatePromotionStack(input({ lines: [line({ taxRateBps: 1000 })],
      promotions: [promotion({ value: 50, conditions: minimum(1050, true) })] }));
    expect(result.discountTotal).toBe(500);
    expect(result.taxTotal).toBe(50);
    expect(result.grandTotal).toBe(650);
    expect(calculatePromotionStack(input({ lines: [line({ taxRateBps: 1000 })], promotions: [promotion({ conditions: minimum(1050) })] })).discountTotal).toBe(0);
  });

  it('keeps rounded gross refund UNIT distinct from rounded gross LINE', () => {
    const result = calculatePromotionStack(input({ lines: [line({ unitListPrice: 1, quantity: 2, placedQuantity: 2, taxRateBps: 5000 })], promotions: [], couponCodes: [] }));
    expect(result.lineSnapshots).toEqual([{ lineKey: 'SKU', quantity: 2, proratedUnitPriceWithTax: 2, lineNet: 2, lineGross: 3 }]);
    expect(result.taxTotal).toBe(1);
  });

  it('caps credit at merchandise after earlier ordinary discounts & preserves signed per-unit provenance', () => {
    const result = calculatePromotionStack(input({ lines: [line({ unitListPrice: 1, quantity: 2, placedQuantity: 2 })], couponCodes: ['CREDIT'], promotions: [
      promotion({ id: 'ordinary', code: null, kind: 'fixed', value: 1 }),
      promotion({ id: 'credit', code: 'CREDIT', kind: 'account_credit', value: 0, priority: 1, sequence: 1, credit: { accountId: 'account', availableCents: 500 } }),
    ] }));
    expect(result.selectedCredit).toEqual({ accountId: 'account', promotionId: 'credit', appliedAmount: 1, allocation: { SKU: [0, 1] } });
    expect(result.applied[1]?.lineAllocations[0]?.units).toEqual([0, -1]);
    expect(result.grandTotal).toBe(100);
    expect(result.coupons[0]).toMatchObject({ appliedAmount: 1, availableAmount: 500, remainingAmount: 499 });
  });

  it('distributes across current gross line weights then equal line units', () => {
    const result = calculatePromotionStack(input({ lines: [line({ key: 'untaxed', unitListPrice: 100 }), line({ key: 'taxed', unitListPrice: 100, taxRateBps: 10000 })],
      promotions: [promotion({ kind: 'fixed', value: 3 })] }));
    expect(result.applied[0]?.lineAllocations.map(allocation => allocation.amount)).toEqual([-1, -2]);
  });

  it('retains source requested/clamped facts while projecting effective reduced-quantity discounts', () => {
    const result = calculatePromotionStack(input({ lines: [line({ quantity: 1, placedQuantity: 2 })] }));
    expect(result.lineSnapshots[0]?.lineNet).toBe(950);
    expect(result.discountTotal).toBe(50);
    expect(result.applied[0]).toMatchObject({ requestedAmount: -100, amount: -50, lineAllocations: [{ amount: -50, units: [-50],
      sourceAdjustmentAmount: -100, sourceUnits: [-100], sourceDiscountAmount: -50, sourceDiscountAmountWithTax: -50 }] });
  });

  it('caps distributed source shares per line & preserves original pre-cap vectors', () => {
    const result = calculatePromotionStack(input({ lines: [line({ key: 'untaxed', unitListPrice: 100 }), line({ key: 'taxed', unitListPrice: 100, taxRateBps: 10000 })],
      promotions: [promotion({ kind: 'fixed', value: 200 })] }));
    expect(result.lineSnapshots.map(snapshot => snapshot.lineNet)).toEqual([33, 0]);
    expect(result.applied[0]).toMatchObject({ requestedAmount: -200, amount: -167, amountWithTax: -267 });
    expect(result.applied[0]?.lineAllocations.map(allocation => [allocation.sourceAdjustmentAmount, allocation.sourceUnits, allocation.amount, allocation.units])).toEqual([
      [-67, [-67], -67, [-67]], [-100, [-133], -100, [-100]],
    ]);
  });

  it('distinguishes source signed-rounded tax discount from rounded economic gross delta', () => {
    const result = calculatePromotionStack(input({ lines: [line({ unitListPrice: 1, taxRateBps: 5000 })], promotions: [promotion({ kind: 'fixed', value: 1 })] }));
    expect(result.applied[0]).toMatchObject({ amount: -1, amountWithTax: -2, lineAllocations: [{ sourceDiscountAmount: -1, sourceDiscountAmountWithTax: -1 }] });
  });

  it('refuses credit whose source debit or original settlement vectors cannot fund redemption', () => {
    const credit = promotion({ kind: 'account_credit', value: 0, credit: { accountId: 'account', availableCents: 100 } });
    try {
      calculatePromotionStack(input({ lines: [line({ unitListPrice: 101, quantity: 1, placedQuantity: 2, priorAdjustments: [{ amount: -1, kind: 'item' }] })],
        promotions: [{ ...credit, credit: { accountId: 'account', availableCents: 1 } }] }));
      throw new Error('Expected source amount refusal');
    } catch (error) { expect(error).toBeInstanceOf(PromotionStackError); expect((error as PromotionStackError).code).toBe('CREDIT_AMOUNT_CHANGED'); }
    expect(() => calculatePromotionStack(input({ lines: [line({ quantity: 1, placedQuantity: 2 })], promotions: [credit] }))).toThrow(/unit allocation/);
    expect(() => calculatePromotionStack(input({ lines: [line({ key: 'untaxed', unitListPrice: 100 }), line({ key: 'taxed', unitListPrice: 100, taxRateBps: 10000 })],
      promotions: [{ ...credit, credit: { accountId: 'account', availableCents: 200 } }] }))).toThrow(/does not match source debit/);
  });

  it('uses max placed/current quantity divisor & ignores prior adjustments on zero-quantity lines', () => {
    const result = calculatePromotionStack(input({ lines: [line({ quantity: 1, placedQuantity: 2, priorAdjustments: [{ amount: -100, kind: 'item' }] }),
      line({ key: 'cancelled', quantity: 0, placedQuantity: 3, priorAdjustments: [{ amount: -3000, kind: 'item' }] })], promotions: [], couponCodes: [] }));
    expect(result.lineSnapshots.map(snapshot => [snapshot.lineNet, snapshot.proratedUnitPriceWithTax])).toEqual([[950, 950], [0, 1000]]);
    expect(result.discountTotal).toBe(50);
  });

  it('does not trim generic coupon identities & refuses ambiguous code ownership', () => {
    expect(canonicalCouponCodes(['SAVE', 'save', ' SAVE '])).toEqual(['SAVE', ' SAVE ']);
    const result = calculatePromotionStack(input({ promotions: [promotion(), promotion({ id: 'duplicate', code: 'save' })] }));
    expect(result.discountTotal).toBe(0);
    expect(result.coupons[0]).toMatchObject({ applied: false, promotionId: null, reason: 'Ambiguous coupon code' });
  });

  it('hashes economics independent of phase/new line UUIDs/unspent available credit', () => {
    const credit = promotion({ kind: 'account_credit', value: 0, credit: { accountId: 'account', availableCents: 2000 } });
    const a = calculatePromotionStack(input({ promotions: [credit] }));
    const b = calculatePromotionStack(input({ phase: 'ArrangingPayment', lines: [line({ key: 'new-native-uuid' })],
      promotions: [{ ...credit, credit: { accountId: 'account', availableCents: 1000 } }] }));
    expect(a.quoteHash).toBe(b.quoteHash);
    expect(calculatePromotionStack(input({ lines: [line({ unitListPrice: 1001 })], promotions: [credit] })).quoteHash).not.toBe(a.quoteHash);
  });

  it('fails unsafe amounts, unknown conditions & duplicate retained current order actions closed', () => {
    expect(() => calculatePromotionStack(input({ lines: [line({ unitListPrice: Number.MAX_SAFE_INTEGER })] }))).toThrow();
    expect(() => calculatePromotionStack(input({ lines: [line({ priorAdjustments: [{ amount: -10, kind: 'order', promotionId: 'promo' }] })] }))).toThrow(/already present/);
    expect(calculatePromotionStack(input({ promotions: [promotion({ conditions: [{ code: 'unknown' }] })] })).discountTotal).toBe(0);
    expect(calculatePromotionStack(input({ promotions: [promotion({ conditions: { malformed: true } })] })).discountTotal).toBe(0);
  });
});
