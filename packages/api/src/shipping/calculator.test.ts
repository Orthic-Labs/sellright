import { describe, it, expect } from 'vitest';
import { isMethodEligible, shippingRate, evaluateShipping } from './calculator.js';

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
