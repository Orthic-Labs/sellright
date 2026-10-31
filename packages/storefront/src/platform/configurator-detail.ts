// Brand views PR2 §7: the branded shop page's loader. The listing (shop-catalog.json) and every configurator product
// (routes.json shop.detailProducts) come from ONE catalog generation, or all from the live API, never a mix. Metadata only: the listing
// keeps the manifest's `inStock` (the shop page's layer-2 source; the in-stock toggle is its only live listing read) and the detail
// carries no stock at all. With no `route.shop` view this loader returns null without any I/O.
import { routeLoader$, server$ } from '@qwik.dev/router';
import { noStore, shellRender } from '~/platform/shell-render';
import { hasView } from '~/platform/gateway';
import { DETAIL_PRODUCTS } from '~/platform/brand-data';
import { productPath } from '~/platform/product-path';
import type { ModelProduct } from '~/platform/controllers/product-model';
import { buildModelProduct, redactModel } from '~/platform/controllers/product-model';
import { liveBrowseCatalog, normalizeBrowseCatalog, type BrowseCatalog } from '~/services/browse-catalog';
import { readCatalogGeneration } from '~/services/catalog-snapshot';
import { catalogInStockOf, v1DetailFile, v2DetailFile } from '~/platform/catalog-stock-hint';
import { manifestProductMeta, normalizeManifestProductDetail, type CatalogListItem, type RawManifestProductDetail } from '~/sellright/types/catalog';
import { modelsFromLive } from '~/platform/product-detail';
import { DEFAULT_CURRENCY } from '~/constants';
import type { ShopListingItem } from '~/platform/views';

export interface ConfiguratorDetail {
	listing: ShopListingItem[];
	detail: ModelProduct[];
	detailStatus: 'ok' | 'partial' | 'unavailable';
	source: 'manifest' | 'network';
	/** ADR-0001: the shell copy (no listing, prices pending); the browser reads the values on load. */
	valuesPending?: boolean;
}

/** One listing item for the view: no stock beyond the listing's own flag. */
export const listingItem = (p: CatalogListItem): ShopListingItem => ({
	slug: String(p.slug),
	name: String(p.name),
	href: productPath(String(p.slug)),
	image: p.image ?? null,
	priceCents: p.pricingVariant?.price ?? p.minPrice ?? 0,
	currencyCode: DEFAULT_CURRENCY,
	availability: p.inStock === true ? 'in-stock' : 'out-of-stock',
});

const statusOf = (resolved: number, wanted: number): ConfiguratorDetail['detailStatus'] => (resolved === 0 ? 'unavailable' : resolved < wanted ? 'partial' : 'ok');

/** Listing + detail from one generation, or null when the generation is invalid or any file of the set is missing. */
export async function fromManifest(read = readCatalogGeneration): Promise<Omit<ConfiguratorDetail, 'source'> | null> {
	const detailFiles = DETAIL_PRODUCTS.map((p) => v1DetailFile(p.slug));
	const hints = DETAIL_PRODUCTS.map((p) => v2DetailFile(p.slug)); // #382 in-stock hint for older generations; optional
	let gen: Awaited<ReturnType<typeof readCatalogGeneration<unknown>>>;
	try {
		gen = await read<unknown>(['shop-catalog.json', ...detailFiles, ...hints]);
	} catch {
		return null;
	}
	if (['shop-catalog.json', ...detailFiles].some((f) => !gen.files[f])) return null;
	try {
		const listing = normalizeBrowseCatalog(gen.files['shop-catalog.json']);
		const detail = DETAIL_PRODUCTS.map((p, i) => {
			const raw = gen.files[detailFiles[i]] as RawManifestProductDetail;
			return buildModelProduct(normalizeManifestProductDetail(raw), { key: p.key, href: productPath(p.slug), ...manifestProductMeta(raw), catalogInStock: catalogInStockOf(raw, gen.files[hints[i]]) });
		}).filter((m) => m.variants.length > 0);
		return { listing: listing.products.map(listingItem), detail, detailStatus: statusOf(detail.length, DETAIL_PRODUCTS.length) };
	} catch {
		return null;
	}
}

/** The branded shop's detail with its values (prices, the listing and its manifest `inStock`). */
export async function buildConfiguratorDetail(): Promise<ConfiguratorDetail> {
	const pinned = await fromManifest();
	if (pinned) return { ...pinned, source: 'manifest' };
	// Live: the whole set from the API. A product that fails is omitted (detailStatus says so); a failed listing is empty.
	const [browse, models] = await Promise.all([
		liveBrowseCatalog().catch((): BrowseCatalog => ({ totalItems: 0, products: [] })),
		modelsFromLive(DETAIL_PRODUCTS.map((p) => ({ key: p.key, slug: p.slug }))),
	]);
	const detail = models.filter((m): m is ModelProduct => !!m && m.variants.length > 0);
	return { listing: browse.products.map(listingItem), detail, detailStatus: statusOf(detail.length, DETAIL_PRODUCTS.length), source: 'network' };
}

/** ADR-0001 §2-§3: the shell copy. The listing is stock-bearing (and priced), so it is empty until the browser's read; the detail keeps
 *  its metadata with prices redacted. */
export const shellConfiguratorDetail = (d: ConfiguratorDetail): ConfiguratorDetail => ({ ...d, listing: [], detail: d.detail.map(redactModel), valuesPending: true });

export const useConfiguratorDetail = routeLoader$(async (): Promise<ConfiguratorDetail | null> => {
	if (!hasView('route.shop')) return null;
	const d = await buildConfiguratorDetail();
	return shellRender() ? shellConfiguratorDetail(d) : d;
});

/** The branded shop's live values in the browser (ADR-0001): the same build, per request, no-store. */
export const readConfiguratorDetail = server$(async function (): Promise<ConfiguratorDetail | null> {
	noStore(this);
	if (!hasView('route.shop')) return null;
	return buildConfiguratorDetail();
});
