import { searchCatalog } from '~/sellright/catalog';
import { normalizeManifestListItem, type CatalogListItem, type RawManifestListItem } from '~/sellright/types/catalog';
import { readCatalogSnapshot } from './catalog-snapshot';

export interface BrowseCatalog {
  totalItems: number;
  products: CatalogListItem[];
}

/** Both paths return browse metadata at SSR time, including a cold deployment.
 *  Always resolves to the native `CatalogListItem` shape regardless of source
 *  (the published manifest snapshot, or the live API on a stale/missing
 *  snapshot) — the shop page never has to branch on where a product came from. */
export async function loadBrowseCatalog(): Promise<BrowseCatalog> {
  try {
    return normalizeBrowseCatalog(await readCatalogSnapshot<unknown>('shop-catalog.json'));
  } catch {
    return liveBrowseCatalog();
  }
}

/** A parsed shop-catalog.json in the native shape (throws on a malformed file). Brand views PR2 §7 reads the listing through this. */
export function normalizeBrowseCatalog(raw: unknown): BrowseCatalog {
  const snapshot = raw as { products?: RawManifestListItem[] } | null;
  if (!snapshot || !Array.isArray(snapshot.products)) throw new Error('Invalid catalog products');
  return {
    totalItems: snapshot.products.length,
    products: snapshot.products.map(normalizeManifestListItem),
  };
}

/** The listing from the live API (the fallback when no valid manifest exists). */
export async function liveBrowseCatalog(): Promise<BrowseCatalog> {
  const result = await searchCatalog({ take: 10000 });
  if (result.items.length !== result.total) throw new Error('Catalog exceeds browse snapshot limit');
  return { totalItems: result.total, products: result.items };
}
