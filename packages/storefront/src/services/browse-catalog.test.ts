import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBrowseCatalog } from './browse-catalog';
import { readCatalogSnapshot } from './catalog-snapshot';
import { srSearch } from '~/utils/sellright';

vi.mock('./catalog-snapshot', () => ({ readCatalogSnapshot: vi.fn() }));
vi.mock('~/utils/sellright', () => ({ srSearch: vi.fn() }));
afterEach(() => vi.resetAllMocks());
describe('server-rendered browse catalog', () => {
  it('uses a verified snapshot without API work', async () => {
    vi.mocked(readCatalogSnapshot).mockResolvedValue({ products: [{ slug: 'snapshot' }] });
    expect(await loadBrowseCatalog()).toEqual({ products: [{ slug: 'snapshot' }] });
    expect(srSearch).not.toHaveBeenCalled();
  });
  it('returns live products on the server when snapshots are absent or stale', async () => {
    vi.mocked(readCatalogSnapshot).mockRejectedValue(new Error('stale'));
    vi.mocked(srSearch).mockResolvedValue({ total: 1, items: [{ slug: 'native', name: 'Native', status: 'active', inStock: false, minPrice: 3000, image: null, tags: ['edc'] }] });
    expect(await loadBrowseCatalog()).toMatchObject({ totalItems: 1, products: [{ id: 'native', priceRange: { min: 3000 }, inStock: false, facetValues: [{ name: 'edc' }] }] });
  });
  it('does not disguise upstream failure as an empty shop', async () => {
    vi.mocked(readCatalogSnapshot).mockRejectedValue(new Error('missing'));
    vi.mocked(srSearch).mockRejectedValue(new Error('upstream unavailable'));
    await expect(loadBrowseCatalog()).rejects.toThrow('upstream unavailable');
  });
});
