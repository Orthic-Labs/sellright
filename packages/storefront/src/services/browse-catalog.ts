import { srAssetUrl, srSearch } from '~/utils/sellright';
import { readCatalogSnapshot } from './catalog-snapshot';

/** Both paths return browse metadata at SSR time, including a cold deployment. */
export async function loadBrowseCatalog() {
  try {
    const snapshot = await readCatalogSnapshot<any>('shop-catalog.json');
    if (!Array.isArray(snapshot.products)) throw new Error('Invalid catalog products');
    return snapshot;
  } catch {
    const result = await srSearch({ take: 10000 });
    if (result.items.length !== result.total) throw new Error('Catalog exceeds browse snapshot limit');
    return {
      totalItems: result.total,
      products: result.items.map(product => ({
        id: product.slug, slug: product.slug, name: product.name,
        featuredAsset: product.image ? { preview: srAssetUrl(product.image) } : null,
        priceRange: { min: product.minPrice ?? 0, max: product.minPrice ?? 0 },
        inStock: product.inStock === true,
        facetValues: (product.tags ?? []).map(name => ({ name, facetName: 'Tags' })),
        customFields: product.pricingVariant ?? {},
      })),
    };
  }
}
