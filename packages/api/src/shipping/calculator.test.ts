import { describe, it, expect } from 'vitest';
import { isMethodEligible, shippingRate, evaluateShipping, freeShippingThreshold } from './calculator.js';

describe('shipping calculator', () => {
  it('flat rate, no constraints, is always eligible', () => {
    expect(evaluateShipping({ flat: 500 }, { subtotal: 0 })).toEqual({ eligible: true, rate: 500 });
  });

  it('defaults missing flat to 0 and clamps negatives', () => {
    expect(shippingRate({})).toBe(0);
    expect(shippingRate({ flat: -100 })).toBe(0);
    expect(shippingRate(null)).toBe(0);
  });

  it('enforces min/max subtotal bounds (inclusive)', () => {
    const calc = { flat: 0, min: 5000, max: 20000 };
    expect(isMethodEligible(calc, { subtotal: 4999 })).toBe(false);
    expect(isMethodEligible(calc, { subtotal: 5000 })).toBe(true);
    expect(isMethodEligible(calc, { subtotal: 20000 })).toBe(true);
    expect(isMethodEligible(calc, { subtotal: 20001 })).toBe(false);
  });

  it('allow-list countries (default) require a match, case-insensitively', () => {
    const calc = { flat: 700, countries: ['US', 'CA'] };
    expect(isMethodEligible(calc, { subtotal: 1, country: 'us' })).toBe(true);
    expect(isMethodEligible(calc, { subtotal: 1, country: 'GB' })).toBe(false);
    expect(isMethodEligible(calc, { subtotal: 1, country: null })).toBe(false);
  });

  it('block-list countries (exclude) reject a match', () => {
    const calc = { flat: 700, countries: ['RU'], exclude: true };
    expect(isMethodEligible(calc, { subtotal: 1, country: 'ru' })).toBe(false);
    expect(isMethodEligible(calc, { subtotal: 1, country: 'US' })).toBe(true);
    expect(isMethodEligible(calc, { subtotal: 1, country: null })).toBe(true);
  });
});

describe('freeShippingThreshold', () => {
  // Rotten Hand's imported methods (discounted_with_tax basis): US free from $1, intl $20 under $100, intl free from $100.
  const methods = [
    { flat: 0, min: 100, max: 1000000, countries: ['US', 'PR'], requireCountry: true, subtotalBasis: 'discounted_with_tax' },
    { flat: 2000, min: 100, max: 9999, countries: ['US', 'PR'], exclude: true, requireCountry: true, subtotalBasis: 'discounted_with_tax' },
    { flat: 0, min: 10000, max: 1000000, countries: ['US', 'PR'], exclude: true, requireCountry: true, subtotalBasis: 'discounted_with_tax' },
  ];
  it('is the free tier minimum for an international cart below it', () => {
    expect(freeShippingThreshold(methods, { country: 'CA', subtotal: 7500, discountedSubtotalWithTax: 7500 })).toEqual({ threshold: 10000, remaining: 2500 });
  });
  it('is null once shipping is free, or for a destination that already ships free', () => {
    expect(freeShippingThreshold(methods, { country: 'CA', subtotal: 12000, discountedSubtotalWithTax: 12000 })).toBeNull();
    expect(freeShippingThreshold(methods, { country: 'US', subtotal: 7500, discountedSubtotalWithTax: 7500 })).toBeNull();
  });
  it('ignores free tiers the destination can never reach, and paid methods', () => {
    expect(freeShippingThreshold([{ flat: 0, min: 5000, countries: ['US'] }, { flat: 999, min: 1 }], { country: 'CA', subtotal: 100 })).toBeNull();
  });
  it('picks the lowest reachable free tier', () => {
    expect(freeShippingThreshold([{ flat: 0, min: 20000 }, { flat: 0, min: 15000 }], { country: 'CA', subtotal: 100 })).toEqual({ threshold: 15000, remaining: 14900 });
  });
});
