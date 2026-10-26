import { describe, expect, it } from 'vitest';
import { isJunkProduct } from './queries.js';

describe('isJunkProduct (product sitemap exclusion, as the previous store)', () => {
  it('excludes test, sample, demo, history and sdfsdf rows by name or slug, case-insensitively', () => {
    expect(isJunkProduct({ name: 'Test Product', slug: 'real-slug' })).toBe(true);
    expect(isJunkProduct({ name: 'Widget', slug: 'sample-widget' })).toBe(true);
    expect(isJunkProduct({ name: 'DEMO knife', slug: 'knife' })).toBe(true);
    expect(isJunkProduct({ name: 'Order history', slug: 'x' })).toBe(true);
    expect(isJunkProduct({ name: 'x', slug: 'sdfsdf' })).toBe(true);
  });

  it('keeps ordinary products', () => {
    expect(isJunkProduct({ name: 'Oni', slug: 'oni' })).toBe(false);
    expect(isJunkProduct({ name: 'Long Sleeve Button-Up Shirt', slug: 'longsleeveshirt' })).toBe(false);
    expect(isJunkProduct({ name: null, slug: null })).toBe(false);
  });
});
