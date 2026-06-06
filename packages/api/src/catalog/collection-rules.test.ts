import { describe, it, expect } from 'vitest';
import { productMatchesRules, parseRules, type MatchableProduct } from './collection-rules.js';

const prod = (over: Partial<MatchableProduct> = {}): MatchableProduct => ({
  name: 'Copper Fidget Spinner', vendor: 'Damned Designs', productType: 'EDC', tags: ['brass', 'desk'], minPrice: 4500, ...over,
});

describe('parseRules', () => {
  it('rejects malformed rules', () => {
    expect(parseRules(null)).toBeNull();
    expect(parseRules({ match: 'all', conditions: [] })).toBeNull();
    expect(parseRules({ match: 'nope', conditions: [{ field: 'tag', op: 'equals', value: 'x' }] })).toBeNull();
  });
  it('accepts valid rules', () => {
    expect(parseRules({ match: 'any', conditions: [{ field: 'tag', op: 'equals', value: 'x' }] })).not.toBeNull();
  });
});

describe('productMatchesRules', () => {
  it('match=all requires every condition', () => {
    const rules = { match: 'all' as const, conditions: [
      { field: 'productType' as const, op: 'equals' as const, value: 'EDC' },
      { field: 'price' as const, op: 'lt' as const, value: '5000' },
    ] };
    expect(productMatchesRules(prod(), rules)).toBe(true);
    expect(productMatchesRules(prod({ minPrice: 6000 }), rules)).toBe(false);
  });
  it('match=any needs only one', () => {
    const rules = { match: 'any' as const, conditions: [
      { field: 'vendor' as const, op: 'equals' as const, value: 'Other Co' },
      { field: 'tag' as const, op: 'contains' as const, value: 'bras' },
    ] };
    expect(productMatchesRules(prod(), rules)).toBe(true);
  });
  it('title contains / starts_with, case-insensitive', () => {
    expect(productMatchesRules(prod(), { match: 'all', conditions: [{ field: 'title', op: 'contains', value: 'fidget' }] })).toBe(true);
    expect(productMatchesRules(prod(), { match: 'all', conditions: [{ field: 'title', op: 'starts_with', value: 'copper' }] })).toBe(true);
  });
  it('price gt/lt numeric', () => {
    expect(productMatchesRules(prod(), { match: 'all', conditions: [{ field: 'price', op: 'gt', value: '4000' }] })).toBe(true);
    expect(productMatchesRules(prod({ minPrice: null }), { match: 'all', conditions: [{ field: 'price', op: 'gt', value: '1' }] })).toBe(false);
  });
});
