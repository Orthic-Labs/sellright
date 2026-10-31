/**
 * #412: the method the cart read's opt-in shipping quote (`GET /v1/shop/cart/{token}?includeShippingMethods=1`) prices the cart
 * with. Pure selection rule; the route itself is covered by cart-shipping-quote.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { selectShippingMethod } from './cart.js';

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
