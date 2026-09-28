import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBrowseCatalog } from './browse-catalog';
import { readCatalogSnapshot } from './catalog-snapshot';
import { searchCatalog } from '~/sellright/catalog';

vi.mock('./catalog-snapshot', () => ({ readCatalogSnapshot: vi.fn() }));
vi.mock('~/sellright/catalog', () => ({ searchCatalog: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('server-rendered browse catalog', () => {
  it('normalizes a verified snapshot to the native shape without API work', async () => {
    vi.mocked(readCatalogSnapshot).mockResolvedValue({
      products: [{
        slug: 'snapshot', name: 'Snapshot', inStock: true,
        priceRange: { min: 1200, max: 1200 },
        tags: ['EDC'],
        featuredImage: { url: '/assets/snapshot.jpg' },
        salePrice: null, preOrderPrice: null, shipDate: null, isPreOrder: false,
      }],
    });
    const result = await loadBrowseCatalog();
    expect(searchCatalog).not.toHaveBeenCalled();
    expect(result).toEqual({
      totalItems: 1,
      products: [{
        slug: 'snapshot', name: 'Snapshot', status: 'active', inStock: true,
        tags: ['EDC'], minPrice: 1200,
        pricingVariant: { sku: 'snapshot', price: 1200, salePrice: null, preOrderPrice: null, isPreOrder: false, shipDate: null },
        image: '/assets/snapshot.jpg',
      }],
    });
  });

  it('returns live products on the server when snapshots are absent or stale', async () => {
    vi.mocked(readCatalogSnapshot).mockRejectedValue(new Error('stale'));
    vi.mocked(searchCatalog).mockResolvedValue({
      total: 1,
      items: [{ slug: 'native', name: 'Native', status: 'active', inStock: false, minPrice: 3000, image: null, tags: ['edc'], pricingVariant: null }],
    });
    const result = await loadBrowseCatalog();
    expect(result).toMatchObject({
      totalItems: 1,
      products: [{ slug: 'native', minPrice: 3000, inStock: false, tags: ['edc'] }],
    });
  });

  it('does not disguise upstream failure as an empty shop', async () => {
    vi.mocked(readCatalogSnapshot).mockRejectedValue(new Error('missing'));
    vi.mocked(searchCatalog).mockRejectedValue(new Error('upstream unavailable'));
    await expect(loadBrowseCatalog()).rejects.toThrow('upstream unavailable');
  });

  it('does not disguise a truncated catalog page as the whole shop', async () => {
    vi.mocked(readCatalogSnapshot).mockRejectedValue(new Error('missing'));
    vi.mocked(searchCatalog).mockResolvedValue({ total: 50, items: [{ slug: 'a', name: 'A', status: 'active', inStock: true, minPrice: 100, image: null, tags: [], pricingVariant: null }] });
    await expect(loadBrowseCatalog()).rejects.toThrow('Catalog exceeds browse snapshot limit');
  });
});
