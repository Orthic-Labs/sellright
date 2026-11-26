import { describe, expect, it } from 'vitest';
import { inventoryQuery } from './inventory-query';

describe('inventoryQuery', () => {
  it('leaves out filters that are off (the API rejects lowStock= with 400)', () => {
    const p = new URLSearchParams(inventoryQuery('', false, 1));
    expect(p.has('lowStock')).toBe(false);
    expect(p.has('q')).toBe(false);
    expect(p.get('page')).toBe('1');
    expect(p.get('pageSize')).toBe('50');
  });
  it('sends the low-stock filter and the search when set', () => {
    const p = new URLSearchParams(inventoryQuery('yokai', true, 3));
    expect(p.get('lowStock')).toBe('1');
    expect(p.get('q')).toBe('yokai');
    expect(p.get('page')).toBe('3');
  });
});
