// The base product page's related row loader (routes.json productPage.related); the pure row is product-related-model.ts.
import { routeLoader$ } from '@qwik.dev/router';
import { normalizeBrowseCatalog } from '~/services/browse-catalog';
import { readCatalogSnapshot } from '~/services/catalog-snapshot';
import { PDP_RELATED } from '~/platform/brand-data';
import { relatedRow, shellRelatedRow, type RelatedRow } from './product-related-model';
import { shellRender } from '~/platform/shell-render';

export type { RelatedCard, RelatedRow } from './product-related-model';

const EMPTY: RelatedRow = { heading: '', items: [] };

/** The related row of the product route; empty without routes.json productPage.related (no I/O). It reads the catalog snapshot only,
 * never the live listing (whose availability is a stock read the product loader must not wait on): no valid snapshot is an empty row. */
export const useRelatedProducts = routeLoader$(async ({ params }): Promise<RelatedRow> => {
	if (!PDP_RELATED) return EMPTY;
	const slug = (params.slug ?? '').replace(/\/$/, '');
	try {
		const catalog = normalizeBrowseCatalog(await readCatalogSnapshot<unknown>('shop-catalog.json'));
		const row = relatedRow(catalog.products, slug);
		// ADR-0001 DP-1: the shell's row has no prices (the order stays the snapshot's, by price): platform/product.ts readProductValues.
		return shellRender() ? shellRelatedRow(row) : row;
	} catch {
		return EMPTY;
	}
// Serialized into the page (names, links, images, prices: no availability). With the router's default ('never') the
// browser re-fetched it after load, and that request re-ran the product route's loaders and their API calls (#362).
}, { serializationStrategy: 'always' });
