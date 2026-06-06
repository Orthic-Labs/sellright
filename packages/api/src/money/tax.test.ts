import { describe, it, expect } from 'vitest';
import { resolveTaxRate } from './tax.js';
import { calculateOrderTotals } from './totals.js';

describe('resolveTaxRate', () => {
  const zones = [
    { countries: ['US'], rate: 875, priority: 0 },
    { countries: ['GB', 'DE'], rate: 2000, priority: 0 },
    { countries: ['US'], rate: 600, priority: 10 }, // higher priority for US
  ];
  it('falls back when country is missing or unmatched', () => {
    expect(resolveTaxRate(zones, null, 500)).toBe(500);
    expect(resolveTaxRate(zones, 'FR', 500)).toBe(500);
  });
  it('matches case-insensitively and honours priority', () => {
    expect(resolveTaxRate(zones, 'gb', 0)).toBe(2000);
    expect(resolveTaxRate(zones, 'US', 0)).toBe(600); // priority 10 wins over 0
  });
});

describe('tax-inclusive totals', () => {
  it('extracts embedded tax instead of adding it', () => {
    // 10000c inclusive of 10% tax: tax portion = 10000 - round(10000*10000/11000) = 10000 - 9091 = 909
    const t = calculateOrderTotals({ lines: [{ unitPrice: 10000, quantity: 1 }], shipping: 0, taxRate: 1000, taxInclusive: true });
    expect(t.taxTotal).toBe(909);
    expect(t.grandTotal).toBe(10000); // total unchanged — tax already inside
  });
  it('exclusive (default) adds tax on top', () => {
    const t = calculateOrderTotals({ lines: [{ unitPrice: 10000, quantity: 1 }], shipping: 0, taxRate: 1000 });
    expect(t.taxTotal).toBe(1000);
    expect(t.grandTotal).toBe(11000);
  });
  it('inclusive with taxable shipping extracts from base+shipping', () => {
    const t = calculateOrderTotals({ lines: [{ unitPrice: 10000, quantity: 1 }], shipping: 1000, taxRate: 1000, taxInclusive: true, shippingTaxable: true });
    // base = 11000 incl; tax = 11000 - round(11000*10000/11000) = 11000 - 10000 = 1000
    expect(t.taxTotal).toBe(1000);
    expect(t.grandTotal).toBe(11000);
  });
});
