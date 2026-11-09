import { describe, expect, it } from 'vitest';
import { normalizeStoreCurrency } from './currency-codes.js';

describe('normalizeStoreCurrency', () => {
  it('upper-cases and trims: " usd " -> USD', () => {
    expect(normalizeStoreCurrency(' usd ')).toBe('USD');
    expect(normalizeStoreCurrency('eur')).toBe('EUR');
  });
  it('rejects zero- and three-decimal currencies', () => {
    expect(normalizeStoreCurrency('JPY')).toBeNull();
    expect(normalizeStoreCurrency('KRW')).toBeNull();
    expect(normalizeStoreCurrency('KWD')).toBeNull();
  });
  it('rejects non-codes', () => {
    expect(normalizeStoreCurrency('')).toBeNull();
    expect(normalizeStoreCurrency('US')).toBeNull();
    expect(normalizeStoreCurrency('dollars')).toBeNull();
  });
});
