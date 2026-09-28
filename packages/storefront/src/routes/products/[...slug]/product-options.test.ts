import { describe, expect, it } from 'vitest';
import { availableForGroup, findVariant, getOptionGroups, priceDeltaLabel } from './product-options';
import type { CatalogVariant } from '~/sellright/types/catalog';

function variant(over: Partial<CatalogVariant> & { sku: string; options: CatalogVariant['options'] }): CatalogVariant {
  return {
    id: over.sku, name: over.sku, price: 1000, salePrice: null, preOrderPrice: null, shipDate: null,
    compareAtPrice: null, isPreOrder: false, enabled: true, assets: [], fulfillmentType: 'physical',
    appKey: null, inStock: true, availableQuantity: 5,
    ...over,
  };
}

const colorGroup = (name: string) => ({ id: name, code: name, name: 'Color' });

describe('getOptionGroups', () => {
  it('collects unique groups/values across variants, sorted', () => {
    const variants = [
      variant({ sku: 'a', options: [{ id: 'red', code: 'red', name: 'Red', group: colorGroup('color') }] }),
      variant({ sku: 'b', options: [{ id: 'blue', code: 'blue', name: 'Blue', group: colorGroup('color') }] }),
    ];
    expect(getOptionGroups(variants)).toEqual([{ groupName: 'Color', values: ['Red', 'Blue'] }]);
  });
});

describe('availableForGroup — LOCKED stock rule', () => {
  const groups = [{ groupName: 'Color', values: ['Red', 'Blue'] }];

  it('excludes an out-of-stock, non-pre-order variant', () => {
    const variants = [
      variant({ sku: 'red', inStock: false, isPreOrder: false, options: [{ id: 'red', code: 'red', name: 'Red', group: colorGroup('color') }] }),
      variant({ sku: 'blue', inStock: true, options: [{ id: 'blue', code: 'blue', name: 'Blue', group: colorGroup('color') }] }),
    ];
    expect(availableForGroup(variants, groups, 0, [])).toEqual(new Set(['Blue']));
  });

  it('includes an out-of-stock pre-order variant (pre-order is always selectable)', () => {
    const variants = [
      variant({ sku: 'red', inStock: false, isPreOrder: true, options: [{ id: 'red', code: 'red', name: 'Red', group: colorGroup('color') }] }),
    ];
    expect(availableForGroup(variants, groups, 0, [])).toEqual(new Set(['Red']));
  });
});

describe('findVariant', () => {
  it('returns the single variant when there are no option groups', () => {
    const v = variant({ sku: 'only', options: [] });
    expect(findVariant([v], [], [])).toBe(v);
  });

  it('resolves the exact variant matching all selected values', () => {
    const groups = [{ groupName: 'Color', values: ['Red', 'Blue'] }];
    const red = variant({ sku: 'red', options: [{ id: 'red', code: 'red', name: 'Red', group: colorGroup('color') }] });
    const blue = variant({ sku: 'blue', options: [{ id: 'blue', code: 'blue', name: 'Blue', group: colorGroup('color') }] });
    expect(findVariant([red, blue], groups, ['Blue'])).toBe(blue);
  });

  it('returns undefined for an incomplete selection', () => {
    const groups = [{ groupName: 'Color', values: ['Red'] }];
    const red = variant({ sku: 'red', options: [{ id: 'red', code: 'red', name: 'Red', group: colorGroup('color') }] });
    expect(findVariant([red], groups, [null])).toBeUndefined();
  });
});

describe('priceDeltaLabel — effective price, not raw price', () => {
  it('uses the sale price (not the regular price) when computing the delta', () => {
    const groups = [
      { groupName: 'Size', values: ['S', 'L'] },
      { groupName: 'Color', values: ['Red'] },
    ];
    // Without a sale, S (1000) would be the overall cheapest, giving it a $0
    // delta — the sale price (500) is what should actually drive the math.
    const s = variant({ sku: 's', price: 1000, salePrice: 500, options: [{ id: 's', code: 's', name: 'S', group: { id: 'size', code: 'size', name: 'Size' } }] });
    const l = variant({ sku: 'l', price: 1000, options: [{ id: 'l', code: 'l', name: 'L', group: { id: 'size', code: 'size', name: 'Size' } }] });
    // S IS the overall-cheapest variant once its sale price is used — $0 delta.
    expect(priceDeltaLabel([s, l], groups, 'S')).toBeNull();
    // L (1000) vs the overall min (S's effective 500) — delta should reflect
    // the sale price, not S's raw $1000 price (which would give +$0).
    expect(priceDeltaLabel([s, l], groups, 'L')).toBe('+$5');
  });
});
