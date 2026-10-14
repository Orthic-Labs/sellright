// The base product page's related row loader (routes.json productPage.related); the pure row is product-related-model.ts.
import { routeLoader$ } from '@qwik.dev/router';
import { normalizeBrowseCatalog } from '~/services/browse-catalog';
import { readCatalogSnapshot } from '~/services/catalog-snapshot';
import { PDP_RELATED } from '~/platform/brand-data';
import { relatedRow, type RelatedRow } from './product-related-model';

export type { RelatedCard, RelatedRow } from './product-related-model';

const EMPTY: RelatedRow = { heading: '', items: [] };

/** The related row of the product route; empty without routes.json productPage.related (no I/O). It reads the catalog snapshot only,
 * never the live listing (whose availability is a stock read the product loader must not wait on): no valid snapshot is an empty row. */
export const useRelatedProducts = routeLoader$(async ({ params }): Promise<RelatedRow> => {
	if (!PDP_RELATED) return EMPTY;
	const slug = (params.slug ?? '').replace(/\/$/, '');
	try {
		const catalog = normalizeBrowseCatalog(await readCatalogSnapshot<unknown>('shop-catalog.json'));
		return relatedRow(catalog.products, slug);
	} catch {
		return EMPTY;
	}
});
