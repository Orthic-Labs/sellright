import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SellRightError } from './client';

// A fresh vi.fn() is assigned per test (see beforeEach below) rather than
// reusing one instance across tests via mockReset/mockClear — this vitest
// install (4.1.11) misattributes a rejection that a later test's try/catch
// properly handles as an unhandled rejection when the SAME mock instance was
// previously reset, even though nothing about the code under test is wrong
// (reproduced with a trivial vi.fn()+beforeEach(()=>mock.mockReset()) with no
// application code at all). Reassigning the instance sidesteps it.
const state = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return { ...actual, sellright: () => ({ GET: state.getMock }) };
});
import {
  fetchProductList,
  fetchProductDetail,
  fetchProductStock,
  fetchProductDetailWithStock,
  fetchCollectionList,
  fetchCollectionDetail,
  searchCatalog,
} from './catalog';

beforeEach(() => { state.getMock = vi.fn(); });

const listItem = (over: Partial<Record<string, unknown>> = {}) => ({
  slug: 'a', name: 'A', status: 'active', inStock: true, tags: [], minPrice: 100,
  pricingVariant: null, image: 'a.jpg', ...over,
});

describe('fetchProductList', () => {
  it('resolves image paths on every item', async () => {
    state.getMock.mockResolvedValue({ data: { items: [listItem()], total: 1 }, error: undefined });
    const res = await fetchProductList({ limit: 10 });
    expect(res.items[0].image).toBe('/assets/a.jpg');
  });
});

describe('fetchProductDetail', () => {
  it('returns null on a 404', async () => {
    state.getMock.mockRejectedValue(new SellRightError(404, { error: { code: 'not_found', message: 'Not found' } }));
    expect(await fetchProductDetail('missing')).toBeNull();
  });

  it('rethrows non-404 errors', async () => {
    state.getMock.mockRejectedValue(new SellRightError(500, { error: { code: 'UNKNOWN_ERROR', message: 'boom' } }));
    await expect(fetchProductDetail('x')).rejects.toThrow('boom');
  });

  it('ships fail-closed stock and resolves image paths', async () => {
    state.getMock.mockResolvedValue({
      data: {
        slug: 'x', name: 'X', description: null, tags: [], status: 'active',
        seoTitle: null, seoDescription: null, currency: 'USD', images: ['x0.jpg'],
        variants: [{
          id: 'S1', sku: 'S1', name: 'Default', price: 1000, salePrice: null, preOrderPrice: null,
          shipDate: null, compareAtPrice: null, isPreOrder: false, enabled: true, options: [],
          assets: [{ preview: 'v0.jpg' }], fulfillmentType: 'physical', appKey: null,
          inStock: true, availableQuantity: 5, // pretend the API sent stock — must still be zeroed
        }],
      },
      error: undefined,
    });
    const product = await fetchProductDetail('x');
    expect(product!.images).toEqual(['/assets/x0.jpg']);
    expect(product!.variants[0].assets[0].preview).toBe('/assets/v0.jpg');
    expect(product!.variants[0].inStock).toBe(false);
    expect(product!.variants[0].availableQuantity).toBe(0);
  });
});

describe('fetchProductStock', () => {
  it('returns null on 404', async () => {
    state.getMock.mockRejectedValue(new SellRightError(404, { error: { code: 'UNKNOWN_ERROR', message: 'nope' } }));
    expect(await fetchProductStock('missing')).toBeNull();
  });
  it('passes through the native stock shape, including explicit null (uncapped)', async () => {
    state.getMock.mockResolvedValue({ data: { variants: [{ sku: 'S1', inStock: true, availableQuantity: null }] }, error: undefined });
    const stock = await fetchProductStock('x');
    expect(stock!.variants[0].availableQuantity).toBeNull();
  });
});

describe('fetchProductDetailWithStock', () => {
  it('merges live stock onto the detail fetch', async () => {
    state.getMock
      .mockResolvedValueOnce({
        data: {
          slug: 'x', name: 'X', description: null, tags: [], status: 'active', seoTitle: null,
          seoDescription: null, currency: 'USD', images: [],
          variants: [{ id: 'S1', sku: 'S1', name: 'D', price: 1000, salePrice: null, preOrderPrice: null,
            shipDate: null, compareAtPrice: null, isPreOrder: false, enabled: true, options: [], assets: [],
            fulfillmentType: 'physical', appKey: null, inStock: false, availableQuantity: 0 }],
        },
        error: undefined,
      })
      .mockResolvedValueOnce({ data: { variants: [{ sku: 'S1', inStock: true, availableQuantity: 7 }] }, error: undefined });
    const product = await fetchProductDetailWithStock('x');
    expect(product!.variants[0]).toMatchObject({ inStock: true, availableQuantity: 7 });
  });

  it('returns null when the product itself 404s', async () => {
    state.getMock.mockRejectedValue(new SellRightError(404, { error: { code: 'UNKNOWN_ERROR', message: 'nope' } }));
    expect(await fetchProductDetailWithStock('missing')).toBeNull();
  });
});

describe('fetchCollectionList / fetchCollectionDetail', () => {
  it('returns the items array', async () => {
    state.getMock.mockResolvedValue({ data: { items: [{ slug: 'c1', name: 'C1', products: 3 }] }, error: undefined });
    expect(await fetchCollectionList()).toEqual([{ slug: 'c1', name: 'C1', products: 3 }]);
  });

  it('returns null on a 404 collection', async () => {
    state.getMock.mockRejectedValue(new SellRightError(404, { error: { code: 'UNKNOWN_ERROR', message: 'nope' } }));
    expect(await fetchCollectionDetail('missing')).toBeNull();
  });

  it('resolves product image paths in a collection detail', async () => {
    state.getMock.mockResolvedValue({
      data: { slug: 'c1', name: 'C1', description: null, seoTitle: null, seoDescription: null,
        products: [listItem({ image: 'p.jpg' })], total: 1, page: 1, pageSize: 60 },
      error: undefined,
    });
    const detail = await fetchCollectionDetail('c1');
    expect(detail!.products[0].image).toBe('/assets/p.jpg');
  });
});

describe('searchCatalog', () => {
  it('falls back to the plain product list when term is empty', async () => {
    state.getMock.mockResolvedValue({ data: { items: [listItem()], total: 1 }, error: undefined });
    await searchCatalog({ take: 10 });
    expect(state.getMock).toHaveBeenCalledWith('/v1/shop/catalog/products', expect.anything());
  });

  it('calls the search endpoint when a term is given', async () => {
    state.getMock.mockResolvedValue({ data: { items: [listItem()], total: 1 }, error: undefined });
    await searchCatalog({ term: 'knife', take: 10 });
    expect(state.getMock).toHaveBeenCalledWith('/v1/shop/catalog/search', expect.anything());
  });

  it('pages transparently past the 100-item API cap', async () => {
    state.getMock
      .mockResolvedValueOnce({ data: { items: Array.from({ length: 100 }, (_, i) => listItem({ slug: `p${i}` })), total: 150 }, error: undefined })
      .mockResolvedValueOnce({ data: { items: Array.from({ length: 50 }, (_, i) => listItem({ slug: `p${100 + i}` })), total: 150 }, error: undefined });
    const result = await searchCatalog({ term: 'x', take: 150 });
    expect(result.items).toHaveLength(150);
    expect(result.total).toBe(150);
  });

  it('throws rather than silently truncating an incomplete page', async () => {
    state.getMock.mockResolvedValueOnce({ data: { items: [], total: 150 }, error: undefined });
    await expect(searchCatalog({ term: 'x', take: 150 })).rejects.toThrow('Incomplete catalog page');
  });
});
