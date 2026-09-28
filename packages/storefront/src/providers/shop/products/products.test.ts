import { describe, expect, it, vi, beforeEach } from 'vitest';

// `vi.hoisted` + reassigning fresh vi.fn() instances per test (see beforeEach)
// rather than reusing one instance across tests via mockReset — this vitest
// install (4.1.11) misattributes a rejection that a later test's try/catch
// properly handles as an unhandled rejection when the SAME mock instance was
// previously reset (reproduced with a trivial vi.fn()+beforeEach(()=>mock.mockReset())
// with no application code at all). Reassigning the instance sidesteps it.
const state = vi.hoisted(() => ({
  fetchProductDetail: vi.fn(),
  fetchProductDetailWithStock: vi.fn(),
  fetchProductStock: vi.fn(),
  fetchProductList: vi.fn(),
  searchCatalog: vi.fn(),
}));

vi.mock('~/sellright/catalog', () => ({
  fetchProductDetail: (...args: unknown[]) => state.fetchProductDetail(...args),
  fetchProductDetailWithStock: (...args: unknown[]) => state.fetchProductDetailWithStock(...args),
  fetchProductStock: (...args: unknown[]) => state.fetchProductStock(...args),
  fetchProductList: (...args: unknown[]) => state.fetchProductList(...args),
  searchCatalog: (...args: unknown[]) => state.searchCatalog(...args),
}));

import { search, searchQueryWithTerm, getProductBySlug, getProductDetail, searchProducts, listProducts } from './products';

beforeEach(() => {
  state.fetchProductDetail = vi.fn();
  state.fetchProductDetailWithStock = vi.fn();
  state.fetchProductStock = vi.fn();
  state.fetchProductList = vi.fn();
  state.searchCatalog = vi.fn();
});

describe('native exports', () => {
  it('getProductDetail ships fail-closed (never blocks the routeLoader on a stock query)', async () => {
    state.fetchProductDetail.mockResolvedValue({ slug: 'x' });
    expect(await getProductDetail('x')).toEqual({ slug: 'x' });
    expect(state.fetchProductDetail).toHaveBeenCalledWith('x');
    expect(state.fetchProductDetailWithStock).not.toHaveBeenCalled();
  });

  it('searchProducts / listProducts pass through to the native fetchers', async () => {
    state.searchCatalog.mockResolvedValue({ items: [], total: 0 });
    state.fetchProductList.mockResolvedValue({ items: [], total: 0 });
    await searchProducts({ term: 'knife' });
    await listProducts({ limit: 5 });
    expect(state.searchCatalog).toHaveBeenCalledWith({ term: 'knife' });
    expect(state.fetchProductList).toHaveBeenCalledWith({ limit: 5 });
  });
});

describe('legacy search()', () => {
  it('maps a native search result to the legacy AdaptedSearchResponse shape', async () => {
    state.searchCatalog.mockResolvedValue({
      total: 1,
      items: [{
        slug: 'knife-1', name: 'Knife One', status: 'active', inStock: true, tags: ['EDC'],
        minPrice: 12000, image: '/assets/knife.jpg',
        pricingVariant: { sku: 'SKU-1', price: 12000, salePrice: 9900, preOrderPrice: null, isPreOrder: false, shipDate: null },
      }],
    });
    const res = await search({ take: 4 });
    expect(res).toEqual({
      totalItems: 1,
      items: [{
        productId: 'knife-1', productName: 'Knife One', slug: 'knife-1', productVariantId: 'SKU-1',
        productAsset: { id: 'knife-1', preview: '/assets/knife.jpg' },
        priceWithTax: { min: 12000, max: 12000 }, inStock: true, currencyCode: 'USD',
        facetValues: [{ name: 'EDC' }],
      }],
      facetValues: [], collections: [],
      itemCustomFields: [{ productVariantId: 'SKU-1', salePrice: 9900, preOrderPrice: null, isPreOrder: false, shipDate: null }],
    });
  });

  it('searchQueryWithTerm ignores facet value ids (SellRight has no facet filtering)', async () => {
    state.searchCatalog.mockResolvedValue({ items: [], total: 0 });
    await searchQueryWithTerm('collection-a', 'term', ['ignored-facet-id'], 0, 10, true);
    expect(state.searchCatalog).toHaveBeenCalledWith({ collectionSlug: 'collection-a', term: 'term', skip: 0, take: 10, inStock: true });
  });
});

describe('legacy getProductBySlug()', () => {
  it('maps a native product+stock result to the legacy AdaptedProduct shape', async () => {
    state.fetchProductDetailWithStock.mockResolvedValue({
      slug: 'p1', name: 'P1', description: 'd', seoTitle: null, seoDescription: null, currency: 'USD',
      images: ['/assets/p1-0.jpg'], tags: ['Sale'],
      variants: [{
        id: 'S1', sku: 'S1', name: 'Default', price: 1000, salePrice: 800, preOrderPrice: null, shipDate: null,
        compareAtPrice: null, isPreOrder: false, enabled: true,
        options: [{ id: 'red', code: 'red', name: 'Red', group: { id: 'color', code: 'color', name: 'Color' } }],
        assets: [], fulfillmentType: 'physical', appKey: null, inStock: true, availableQuantity: 3,
      }],
    });
    const product = await getProductBySlug('p1');
    expect(product).toMatchObject({
      id: 'p1', slug: 'p1', name: 'P1',
      featuredAsset: { id: 'p1-0', preview: '/assets/p1-0.jpg' },
      variants: [{
        id: 'S1', sku: 'S1', price: 1000, priceWithTax: 800, stockLevel: '999',
        customFields: { salePrice: 800, preOrderPrice: null, isPreOrder: false, shipDate: null },
      }],
    });
  });

  it('fails closed on stockLevel when the merged variant is not in stock', async () => {
    state.fetchProductDetailWithStock.mockResolvedValue({
      slug: 'p1', name: 'P1', description: null, seoTitle: null, seoDescription: null, currency: 'USD',
      images: [], tags: [],
      variants: [{ id: 'S1', sku: 'S1', name: 'D', price: 1000, salePrice: null, preOrderPrice: null, shipDate: null,
        compareAtPrice: null, isPreOrder: false, enabled: true, options: [], assets: [], fulfillmentType: 'physical',
        appKey: null, inStock: false, availableQuantity: 0 }],
    });
    const product = await getProductBySlug('p1');
    expect(product!.variants[0].stockLevel).toBe('0');
  });

  it('returns null (not a throw) when the native fetch 404s', async () => {
    state.fetchProductDetailWithStock.mockResolvedValue(null);
    expect(await getProductBySlug('missing')).toBeNull();
  });

  it('returns null on any other transport error, matching pre-conversion behavior', async () => {
    state.fetchProductDetailWithStock.mockRejectedValue(new Error('network down'));
    expect(await getProductBySlug('x')).toBeNull();
  });
});
