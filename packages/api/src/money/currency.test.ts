import { describe, it, expect } from 'vitest';
import { convertMoney, rateFor, RATE_SCALE } from './currency.js';

describe('currency conversion', () => {
  it('converts cents by a scaled rate', () => {
    expect(convertMoney(10000, 10834)).toBe(10834); // $100.00 × 1.0834 → 108.34
    expect(convertMoney(4500, 9100)).toBe(4095); // ×0.91
  });
  it('base currency and unlisted currency both return the identity rate', () => {
    const rates = [{ currency: 'EUR', rate: 9100, enabled: true }];
    expect(rateFor(rates, 'USD', 'usd')).toBe(RATE_SCALE);
    expect(rateFor(rates, 'USD', 'JPY')).toBe(RATE_SCALE); // unlisted → base
    expect(rateFor(rates, 'USD', 'EUR')).toBe(9100);
  });
  it('skips disabled rates', () => {
    expect(rateFor([{ currency: 'EUR', rate: 9100, enabled: false }], 'USD', 'EUR')).toBe(RATE_SCALE);
  });
});
