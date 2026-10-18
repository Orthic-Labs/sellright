import { describe, expect, it } from 'vitest';
import { calculatePromotionStack, type StackInput } from './promotion-stack.js';
import { buildOrderPricingSnapshot, promotionQuoteHash, readOrderPricingSnapshot } from './pricing-snapshot.js';

const ACCOUNT = 'cccccccc-0000-4000-8000-000000000001';
const PROMOTION = 'cccccccc-0000-4000-8000-000000000002';
const LINE = 'cccccccc-0000-4000-8000-000000000003';
const SECOND_LINE = 'cccccccc-0000-4000-8000-000000000004';
function fixture(): StackInput {
  return { lines: [{ key: 'synthetic-sku', quantity: 3, placedQuantity: 3, unitListPrice: 100, priceIncludesTax: false, taxRateBps: 875 }],
    promotions: [{ id: PROMOTION, code: 'SYNTHETIC', kind: 'account_credit', scope: 'order', value: 0,
      priority: 0, sequence: 1, freeShipping: false, conditions: null, credit: { accountId: ACCOUNT, availableCents: 101 } }],
    couponCodes: ['SYNTHETIC'], phase: 'AddingItems', currency: 'USD', pricesIncludeTax: false,
    shipping: 50, shippingTaxRateBps: 875, shippingIncludesTax: false, couponContext: { activeVerifications: [] } };
}
function saved() { const input = fixture(); const result = calculatePromotionStack(input);
  return buildOrderPricingSnapshot(input, result, new Map([['synthetic-sku', LINE]])); }
const context = { currency: 'USD', orderLines: [{ id: LINE, quantity: 3 }], mode: 'settlement' as const };

describe('immutable accepted pricing snapshots', () => {
  it('preserves uneven signed vectors & maps only proven native line UUIDs', () => {
    const snapshot = saved();
    expect(snapshot.selectedCredit?.allocation[LINE]?.reduce((a, b) => a + b, 0)).toBe(101);
    expect(new Set(snapshot.selectedCredit?.allocation[LINE]).size).toBe(2);
    expect(readOrderPricingSnapshot(snapshot, { ...context, totals: snapshot.totals })).toEqual(snapshot);
    const input = fixture(); const result = calculatePromotionStack(input);
    expect(() => buildOrderPricingSnapshot(input, result, new Map())).toThrow('bijective');
    expect(() => buildOrderPricingSnapshot(input, result, new Map([['other-sku', LINE]]))).toThrow('missing native');
  });
  it('excludes phase & unspent balance while binding shipping, tax, coupon order & unit vectors', () => {
    const input = fixture(); const result = calculatePromotionStack(input);
    expect(calculatePromotionStack({ ...input, phase: 'ArrangingPayment' }).quoteHash).toBe(result.quoteHash);
    const moreBalance = structuredClone(input); moreBalance.promotions[0]!.credit!.availableCents = 102;
    expect(promotionQuoteHash(moreBalance, result)).toBe(result.quoteHash);
    expect(promotionQuoteHash({ ...input, shipping: 51 }, result)).not.toBe(result.quoteHash);
    expect(promotionQuoteHash({ ...input, shippingTaxRateBps: 0 }, result)).not.toBe(result.quoteHash);
    expect(promotionQuoteHash({ ...input, couponCodes: ['OTHER', 'SYNTHETIC'] }, result)).not.toBe(result.quoteHash);
    const altered = structuredClone(result); altered.applied[0]!.lineAllocations[0]!.units.reverse();
    expect(promotionQuoteHash(input, altered)).not.toBe(result.quoteHash);
  });
  it('rejects remapped, missing, reordered or economically altered snapshots', () => {
    const snapshot = saved();
    expect(() => readOrderPricingSnapshot(snapshot, { ...context, orderLines: [{ id: ACCOUNT, quantity: 3 }] })).toThrow('line identity');
    expect(() => readOrderPricingSnapshot(snapshot, { ...context, orderLines: [] })).toThrow('closure');
    const money = structuredClone(snapshot); money.totals.grandTotal += 1;
    expect(() => readOrderPricingSnapshot(money, context)).toThrow('economic hash');
    const allocation = structuredClone(snapshot); allocation.selectedCredit!.allocation[LINE]!.reverse();
    expect(() => readOrderPricingSnapshot(allocation, context)).toThrow('provenance');
  });
  it('allows reduced refund quantity while retaining purchased vector & rejects settlement quantity changes', () => {
    const snapshot = saved(); const reduced = { currency: 'USD', orderLines: [{ id: LINE, quantity: 1 }] };
    expect(readOrderPricingSnapshot(snapshot, { ...reduced, mode: 'refund' })?.selectedCredit?.allocation[LINE]).toHaveLength(3);
    expect(() => readOrderPricingSnapshot(snapshot, { ...reduced, mode: 'settlement' })).toThrow('purchased quantity');
    expect(readOrderPricingSnapshot(null, { ...context, mode: 'refund' })).toBeNull();
    expect(() => readOrderPricingSnapshot({ version: 999 }, context)).toThrow('version');
  });
  it('preserves source exposed tax discount separately from effective rounded gross delta', () => {
    const input = fixture();
    input.lines = [{ key: 'rounding', quantity: 1, placedQuantity: 1, unitListPrice: 1, priceIncludesTax: false, taxRateBps: 5000 }];
    input.promotions = [{ id: PROMOTION, code: 'SYNTHETIC', kind: 'fixed', scope: 'order', value: 1,
      priority: 0, sequence: 1, freeShipping: false, conditions: null }];
    const result = calculatePromotionStack(input);
    expect(result.applied[0]!.amountWithTax).toBe(-2);
    expect(result.applied[0]!.lineAllocations[0]!.sourceDiscountAmountWithTax).toBe(-1);
    const snapshot = buildOrderPricingSnapshot(input, result, new Map([['rounding', LINE]]));
    expect(readOrderPricingSnapshot(snapshot, { ...context, orderLines: [{ id: LINE, quantity: 1 }] })).toEqual(snapshot);
    const altered = structuredClone(result); altered.applied[0]!.lineAllocations[0]!.sourceDiscountAmountWithTax = -2;
    expect(promotionQuoteHash(input, altered)).not.toBe(result.quoteHash);
  });
  it('validates shipping discounts separately from merchandise unit vectors', () => {
    const input = fixture();
    input.promotions = [{ id: PROMOTION, code: 'SYNTHETIC', kind: 'free_shipping', scope: 'order', value: 0,
      priority: 0, sequence: 1, freeShipping: true, conditions: null }];
    const result = calculatePromotionStack(input);
    expect(result.applied[0]!.amount).toBe(-50);
    expect(result.applied[0]!.lineAllocations).toEqual([]);
    const snapshot = buildOrderPricingSnapshot(input, result, new Map([['synthetic-sku', LINE]]));
    expect(readOrderPricingSnapshot(snapshot, context)).toEqual(snapshot);
    const altered = structuredClone(snapshot); altered.applied[0]!.amount -= 1;
    expect(() => readOrderPricingSnapshot(altered, context)).toThrow('shipping discount sum');
  });
  it.each([
    { amount: -200, taxTotal: -10, grandTotal: 890 },
    { amount: -1009, taxTotal: -91, grandTotal: 0 },
  ])('round-trips signed surcharge tax $taxTotal with payable $grandTotal', ({ amount, taxTotal, grandTotal }) => {
    // Captured Surcharge.priceWithTax rounds negative gross too: -1009 @ 10% => -1110.
    const input: StackInput = { ...fixture(), lines: [
      { key: 'taxed', quantity: 1, placedQuantity: 1, unitListPrice: 100, priceIncludesTax: false, taxRateBps: 1000 },
      { key: 'untaxed', quantity: 1, placedQuantity: 1, unitListPrice: 1000, priceIncludesTax: false, taxRateBps: 0 },
    ], promotions: [], couponCodes: [], shipping: 0, shippingTaxRateBps: 0, pointsDiscount: 0,
    adjustments: [{ label: 'Signed taxable source adjustment', amount, taxable: true }] };
    const result = calculatePromotionStack(input);
    expect(result).toMatchObject({ subtotal: 1100, discountTotal: 0, shippingTotal: 0, pointsDiscount: 0, taxTotal, grandTotal });
    const snapshot = buildOrderPricingSnapshot(input, result, new Map([['taxed', LINE], ['untaxed', SECOND_LINE]]));
    const native = [{ id: LINE, quantity: 1 }, { id: SECOND_LINE, quantity: 1 }];
    const persisted: unknown = JSON.parse(JSON.stringify(snapshot));
    expect(readOrderPricingSnapshot(persisted, { currency: 'USD', orderLines: native, totals: result, mode: 'settlement' })).toEqual(snapshot);
    expect(readOrderPricingSnapshot(persisted, { currency: 'USD', orderLines: native, mode: 'refund' })?.quoteHash).toBe(result.quoteHash);
    expect(promotionQuoteHash(input, result)).toBe(result.quoteHash);
    expect(promotionQuoteHash(input, { ...result, taxTotal: taxTotal + 1 })).not.toBe(result.quoteHash);
    const changed = structuredClone(snapshot); changed.totals.taxTotal += 1;
    expect(() => readOrderPricingSnapshot(changed, { currency: 'USD', orderLines: native, mode: 'settlement' })).toThrow('economic hash');
  });
  it('rejects noninteger, unsafe or out-of-range tax & keeps other totals nonnegative', () => {
    for (const taxTotal of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, -2_147_483_648, 2_147_483_648]) {
      const snapshot = saved(); snapshot.totals.taxTotal = taxTotal;
      expect(() => readOrderPricingSnapshot(snapshot, context)).toThrow('money must fit integer cents');
    }
    for (const key of ['subtotal', 'discountTotal', 'shippingTotal', 'grandTotal', 'pointsDiscount'] as const) {
      const snapshot = saved(); snapshot.totals[key] = -1;
      expect(() => readOrderPricingSnapshot(snapshot, context)).toThrow('money must fit integer cents');
    }
  });
});
