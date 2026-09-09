import { describe, expect, it } from 'vitest';
import { migrationId } from './context.js';
import { allocateRefundItems } from './history.js';
import { mapShipping } from './settings.js';
import { isMethodEligible } from '../shipping/calculator.js';
import { calculateOrderTotals } from '../money/totals.js';
import { evaluateCoupon } from '../money/coupon.js';

const operation = (code: string, args: Record<string, string>) => ({
  code, args: Object.entries(args).map(([name, value]) => ({ name, value })),
});

describe('Vendure migration contracts', () => {
  it('keeps source identities stable and separates tenants and entity types', () => {
    const id = migrationId('dd', 'vendure:damned', 'customer', 12);
    expect(migrationId('dd', 'vendure:damned', 'customer', '12')).toBe(id);
    expect(migrationId('rh', 'vendure:rotten', 'customer', 12)).not.toBe(id);
    expect(migrationId('dd', 'vendure:damned', 'order', 12)).not.toBe(id);
  });
  it('allocates refund cents exactly with deterministic rounding', () => {
    expect(allocateRefundItems(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateRefundItems(0, [0])).toEqual([0]);
    expect(() => allocateRefundItems(1, [])).toThrow();
  });
  it('preserves DD discounted-tax-inclusive shipping thresholds and empty country rules', () => {
    const calc = mapShipping(operation('custom-shipping-eligibility', { countries: 'US', minAmount: '100' }),
      operation('default-shipping-calculator', { rate: '900', taxRate: '0', includesTax: 'exclude' }), false);
    expect(calc.flat).toBe(900);
    expect(isMethodEligible(calc, { country: 'US', subtotal: 12000, discountedSubtotalWithTax: 9999 })).toBe(false);
    expect(isMethodEligible(calc, { country: 'US', subtotal: 12000, discountedSubtotalWithTax: 10000 })).toBe(true);
    expect(isMethodEligible({ ...calc, countries: [] }, { country: 'US', subtotal: 12000, discountedSubtotalWithTax: 12000 })).toBe(false);
    expect(isMethodEligible({ ...calc, countries: [], exclude: true }, { subtotal: 12000, discountedSubtotalWithTax: 12000 })).toBe(false);
  });
  it('preserves a shipping tax rate distinct from product tax', () => {
    const totals = calculateOrderTotals({ lines: [{ unitPrice: 10000, quantity: 1 }],
      shipping: 1000, taxRate: 1000, shippingTaxRate: 500, shippingTaxInclusive: false });
    expect(totals.taxTotal).toBe(1050);
    expect(totals.grandTotal).toBe(12050);
  });
  it('requires the right facet combination and quantity for source coupons', () => {
    const promo = { type: 'percentage' as const, value: 10,
      conditions: [operation('at_least_n_with_facets', { minimum: '2', facets: '["1","2"]' })] };
    const base = { subtotal: 10000, activeVerifications: [] };
    expect(evaluateCoupon(promo, base).valid).toBe(false);
    expect(evaluateCoupon(promo, { ...base, items: [{ quantity: 2, facetValueIds: ['1'] }] }).valid).toBe(false);
    expect(evaluateCoupon(promo, { ...base, items: [{ quantity: 2, facetValueIds: ['1', '2'] }] }).valid).toBe(true);
  });
});
