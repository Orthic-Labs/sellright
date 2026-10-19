import { describe, expect, it, vi } from 'vitest';
import { searchByCategories } from './categories';
import { categoryFacets, filterCategoryProducts, projectShopCategories } from '~/utils/shop-categories';
import type { CatalogListItem } from '~/sellright/types/catalog';

const item = (slug: string, tags: string[]): CatalogListItem => ({
  slug, name: slug, tags, status: 'active', inStock: false,
  minPrice: 100, image: null, pricingVariant: null,
});
// Published DD labels with legacy IDs proven by its retained shop source.
const categories = projectShopCategories(
  ['folding knives', 'fixed blades', 'edc', 'fidget', 'apparel'],
  '1,3,5,6,4',
);
const tee = { ...item('t-shirt-mascot', ['apparel']), name: 'Mascot Tee' };
const fidget = item('roninv2', ['fidget']);
const products = [
  item('anzu', ['folding knives']), item('basilisk-fixed', ['fixed blades']),
  item('babushka-bead', ['edc']), fidget, tee,
];

describe('shared shop/search category identity', () => {
  it('preserves every configured legacy ID in native controls and tag filtering', () => {
    expect(categoryFacets(categories, ['4'])).toEqual([{
      id: 'category', name: 'Category', open: true,
      values: [
        { id: '1', name: 'folding knives', selected: false },
        { id: '3', name: 'fixed blades', selected: false },
        { id: '5', name: 'edc', selected: false },
        { id: '6', name: 'fidget', selected: false },
        { id: '4', name: 'apparel', selected: true },
      ],
    }]);
    for (const [index, id] of ['1', '3', '5', '6', '4'].entries()) {
      expect(filterCategoryProducts(products, categories, [id])).toEqual([products[index]]);
    }
  });

  it('defaults to positional IDs when stable IDs are absent, without a universal apparel ID', () => {
    const generic = projectShopCategories(['Puzzles', 'Apparel']);
    expect(generic).toEqual([{ id: '1', name: 'Puzzles' }, { id: '2', name: 'Apparel' }]);
    const puzzle = item('puzzle', ['Puzzles']);
    expect(filterCategoryProducts([puzzle, item('tee', ['Apparel'])], generic, ['1'])).toEqual([puzzle]);
  });

  it.each(['', ' ', '1,2', '1,2,3,4,5,6', '1,3,5,6,', '1,3,5,6,6', '1,3,5,6,4-5', '1,3,5,6,apparel'])(
    'rejects malformed explicit IDs %j instead of assigning positional IDs',
    (ids) => expect(() => projectShopCategories(categories.map(({ name }) => name), ids)).toThrow('Invalid VITE_SHOP_CATEGORY_IDS'),
  );

  it('trims valid IDs without changing category labels or order', () => {
    expect(projectShopCategories(['First', 'Second'], ' 6 , 4 ')).toEqual([
      { id: '6', name: 'First' }, { id: '4', name: 'Second' },
    ]);
  });

  it('keeps retired/unknown-only selections empty and combines known IDs with OR', () => {
    expect(filterCategoryProducts(products, categories, ['2'])).toEqual([]);
    expect(filterCategoryProducts(products, categories, ['999'])).toEqual([]);
    expect(filterCategoryProducts(products, categories, ['2', '4', '6'])).toEqual([fidget, tee]);
    expect(filterCategoryProducts(products, categories, [])).toBe(products);
  });
});

describe('search category URL contract', () => {
  it('narrows retained f=4 to Mascot Tee, preserving native stock and prices', async () => {
    const search = vi.fn().mockResolvedValue({ total: products.length, items: products });
    expect(await searchByCategories('', ['4'], categories, search)).toEqual({ total: 1, items: [tee] });
    expect(search).toHaveBeenCalledWith({ term: undefined, take: 10000 });
  });

  it('keeps f=6 bound to fidget rather than configuration position', async () => {
    const search = vi.fn().mockResolvedValue({ total: products.length, items: products });
    expect(await searchByCategories('', ['6'], categories, search)).toEqual({ total: 1, items: [fidget] });
  });

  it('preserves text search while combining selected categories and unknown IDs', async () => {
    const search = vi.fn().mockResolvedValue({ total: products.length, items: products });
    expect(await searchByCategories('matching', ['6', '4', '2'], categories, search)).toEqual({ total: 2, items: [fidget, tee] });
    expect(search).toHaveBeenCalledWith({ term: 'matching', take: 10000 });
  });

  it('keeps unfiltered text search on its existing 60-result path', async () => {
    const result = { total: 100, items: [item('first', [])] };
    const search = vi.fn().mockResolvedValue(result);
    expect(await searchByCategories('term', [], categories, search)).toBe(result);
    expect(search).toHaveBeenCalledWith({ term: 'term', take: 60 });
  });

  it('returns zero for retired ID2 and unknown-only URLs without broadening results', async () => {
    const search = vi.fn();
    expect(await searchByCategories('term', ['2'], categories, search)).toEqual({ items: [], total: 0 });
    expect(await searchByCategories('', ['999'], categories, search)).toEqual({ items: [], total: 0 });
    expect(search).not.toHaveBeenCalled();
  });

  it('filters beyond the first 60 search matches before applying the display limit', async () => {
    const many = [
      ...Array.from({ length: 60 }, (_unused, index) => item('other-' + index, [])),
      ...Array.from({ length: 61 }, (_unused, index) => item('tee-' + index, ['apparel'])),
    ];
    const search = vi.fn().mockResolvedValue({ total: many.length, items: many });
    const result = await searchByCategories('', ['4'], categories, search);
    expect(result.total).toBe(61);
    expect(result.items).toEqual(many.slice(60, 120));
  });

  it('returns an empty category result rather than unrelated products', async () => {
    const search = vi.fn().mockResolvedValue({ total: 1, items: [fidget] });
    expect(await searchByCategories('', ['4'], categories, search)).toEqual({ total: 0, items: [] });
  });

  it('rejects incomplete category input rather than claiming filtered catalog completeness', async () => {
    const search = vi.fn().mockResolvedValue({ total: 10001, items: [tee] });
    await expect(searchByCategories('', ['4'], categories, search)).rejects.toThrow('Catalog exceeds category search limit');
  });
});
