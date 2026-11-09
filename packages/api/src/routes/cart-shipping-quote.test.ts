/**
 * #412: the method the cart read's opt-in shipping quote (`GET /v1/shop/cart/{token}?includeShippingMethods=1`) prices the cart
 * with. Pure selection rule; the route itself is covered by cart-shipping-quote.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { selectShippingMethod, shippingQuotePrice } from './cart.js';
import { resolveTaxRate } from '../money/tax.js';

const methods = [{ code: 'express', rate: 1500 }, { code: 'standard', rate: 500 }, { code: 'economy', rate: 500 }];

describe('selectShippingMethod', () => {
  it('keeps the requested method while it is eligible', () => {
    expect(selectShippingMethod(methods, 'express')).toBe('express');
    expect(selectShippingMethod(methods, 'economy')).toBe('economy');
  });

  it('otherwise picks the storefront default: the cheapest, the first of equal rates in quote order', () => {
    expect(selectShippingMethod(methods)).toBe('standard');
    expect(selectShippingMethod(methods, 'pickup')).toBe('standard');
    expect(selectShippingMethod(methods, '')).toBe('standard');
  });

  it('has no method when nothing is eligible', () => {
    expect(selectShippingMethod([], 'standard')).toBeUndefined();
    expect(selectShippingMethod([])).toBeUndefined();
  });
});

describe('shippingQuotePrice (destination tax zone)', () => {
  const st = { taxInclusive: false, shippingTaxable: true };
  const calc = { flat: 1000 };
  it('zone 875 bps on a store rate of 0, flat 1000, taxable, exclusive -> 1088 (not 1000)', () => {
    const zones = [{ countries: ['US'], rate: 875, priority: 0 }];
    const rate = resolveTaxRate(zones, 'US', 0);
    expect(rate).toBe(875);
    expect(shippingQuotePrice(st, calc, rate)).toBe(1088);
    expect(shippingQuotePrice(st, calc, 0)).toBe(1000);
  });
  it('a country outside every zone falls back to the store rate', () => {
    expect(shippingQuotePrice(st, calc, resolveTaxRate([{ countries: ['US'], rate: 875, priority: 0 }], 'CA', 0))).toBe(1000);
  });
  it('shipping not taxable ignores the zone rate', () => {
    expect(shippingQuotePrice({ taxInclusive: false, shippingTaxable: false }, calc, 875)).toBe(1000);
  });
});
