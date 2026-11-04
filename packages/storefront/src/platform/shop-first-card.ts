// #425: pure; used by the shop route head (platform/shop.ts).
import { listingRank } from '~/platform/brand-data';
import type { CatalogListItem } from '~/sellright/types/catalog';

/** #425: the image of the grid's first card (the LCP candidate), as the grid orders it: the cached shell paints every product in
 *  merchandising order; the uncached render puts in-stock first. Null for a branded shop or an empty listing. */
export function firstCardImage(listing: { products?: CatalogListItem[]; deferred?: boolean } | null | undefined): string | null {
 const items = [...(listing?.products ?? [])];
 if (!items.length) return null;
 items.sort((a, b) => (listing?.deferred ? 0 : Number(!!b.inStock) - Number(!!a.inStock)) || listingRank(a.slug) - listingRank(b.slug));
 return items[0]?.image ?? null;
}
