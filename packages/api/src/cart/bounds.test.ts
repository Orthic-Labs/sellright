import { describe, expect, it } from 'vitest';
import { normalizeCartLines } from './bounds.js';
describe('cart batch semantics', () => {
  it('sets the last duplicate including zero, preserving create positive-only filtering', () => {
    const lines = [{ sku: 'A', quantity: 2 }, { sku: 'A', quantity: 0 }, { sku: 'B', quantity: 3 }];
    expect(normalizeCartLines(lines, 'set')).toEqual([{ sku: 'A', quantity: 0 }, { sku: 'B', quantity: 3 }]);
    expect(normalizeCartLines(lines.filter(line => line.quantity > 0), 'set')).toEqual([{ sku: 'A', quantity: 2 }, { sku: 'B', quantity: 3 }]);
  });
  it('sums duplicate increments', () => {
    expect(normalizeCartLines([{ sku: 'A', quantity: 2 }, { sku: 'A', quantity: 3 }], 'increment')).toEqual([{ sku: 'A', quantity: 5 }]);
  });
});
