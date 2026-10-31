// Brand views PR2 §6-§8: the branded product page's loader and head. Metadata only: no stock is read here (the controller makes the
// view's one live read in the browser). The route product and its siblings come from ONE catalog generation, or all of them from the
// live API, never a mix. With no `route.product` view this loader returns null without any I/O, and the route keeps today's loader
// and head untouched.
import { routeLoader$, server$, type DocumentHeadValue } from '@qwik.dev/router';
import { noStore, shellRender } from '~/platform/shell-render';
import { hasView } from '~/platform/gateway';
import { DETAIL_PRODUCTS } from '~/platform/brand-data';
import { detailSet, productSlugOf, withCanonicalUrls } from '~/platform/product-detail-model';

export { detailSet, productSlugOf, withCanonicalUrls };
import { productPath, productUrl } from '~/platform/product-path';
import { buildModelProduct, redactModel, type ModelProduct } from '~/platform/controllers/product-model';
import { readCatalogGeneration } from '~/services/catalog-snapshot';
import { catalogInStockOf, v1DetailFile, v2DetailFile } from '~/platform/catalog-stock-hint';
import { getProductDetail } from '~/providers/shop/products/products';
import { getProductReviews } from '~/providers/shop/rewards/rewards';
import { liveProductMeta, manifestProductMeta, normalizeManifestProductDetail, type RawManifestProductDetail } from '~/sellright/types/catalog';
import { generateBreadcrumbSchema } from '~/services/seo-schemas';
import { generateImagePreloadLinks } from '~/components/ui/LazyImage';
import { withAggregateRating } from '~/utils/rewards';
import { createSEOHead } from '~/utils/seo';
import { stripHtml } from '~/utils/sanitize';
import { siteUrl, theme } from '~/theme/theme.config';
import type { JsonLdSchema } from '~/types/seo.types';
import { useProductJsonLd } from '~/platform/product';
import { productOgMeta, withProductFacts } from '~/platform/product-jsonld';

const SAFE_SLUG = /^[a-z0-9][a-z0-9\-_]*$/;

export type BrandProductDetail =
	| { state: 'found'; product: ModelProduct; siblings: ModelProduct[]; breadcrumbs: { name: string; href: string }[]; source: 'manifest' | 'network' }
	| { state: 'missing' };

const MISSING: BrandProductDetail = { state: 'missing' };

/** Every product of `set` from one generation, or null when the generation is invalid or any file is missing. */
export async function modelsFromManifest(set: readonly { key: string; slug: string }[], read = readCatalogGeneration): Promise<ModelProduct[] | null> {
	const files = set.map((p) => v1DetailFile(p.slug));
	const hints = set.map((p) => v2DetailFile(p.slug)); // #382 in-stock hint for older generations; optional
	let gen: Awaited<ReturnType<typeof readCatalogGeneration<RawManifestProductDetail>>>;
	try {
		gen = await read<RawManifestProductDetail>([...files, ...hints]);
	} catch {
		return null;
	}
	if (files.some((f) => !gen.files[f])) return null;
	try {
		return set.map((p, i) => {
			const raw = gen.files[files[i]] as RawManifestProductDetail;
			return buildModelProduct(normalizeManifestProductDetail(raw), { key: p.key, href: productPath(p.slug), ...manifestProductMeta(raw), catalogInStock: catalogInStockOf(raw, gen.files[hints[i]]) });
		});
	} catch {
		return null;
	}
}

/** Every product of `set` from the live API (metadata, stock fail-closed); a product that fails is null. */
export async function modelsFromLive(set: readonly { key: string; slug: string }[], detail = getProductDetail, reviews = getProductReviews): Promise<(ModelProduct | null)[]> {
	return Promise.all(
		set.map(async (p) => {
			try {
				const product = await detail(p.slug);
				if (!product) return null;
				const r = await reviews(p.slug, { limit: 1 }).catch(() => null);
				return buildModelProduct(product, { key: p.key, href: productPath(p.slug), ...liveProductMeta(product, r) });
			} catch (error) {
				// detail() returns null for a real 404; a throw is the API failing. The page's own product must not turn into a 404.
				if (p === set[0]) throw error;
				return null;
			}
		}),
	);
}

/** The branded product page's detail. Status 404 for an invalid slug, an unknown product and a product with no variants. */
/** The found/missing detail of a valid slug, with its values. `unavailable` = the API failed (the loader answers 503). */
export async function buildBrandProductDetail(slug: string): Promise<BrandProductDetail | 'unavailable'> {
	const set = detailSet(slug);
	let source: 'manifest' | 'network' = 'manifest';
	let models: (ModelProduct | null)[] | null = await modelsFromManifest(set);
	if (!models) {
		source = 'network';
		try {
			models = await modelsFromLive(set);
		} catch {
			return 'unavailable';
		}
	}
	const product = models[0];
	if (!product || product.variants.length === 0) return MISSING;
	const member = DETAIL_PRODUCTS.find((m) => m.slug === slug);
	return {
		state: 'found',
		product,
		siblings: models.slice(1).filter((m): m is ModelProduct => !!m && m.variants.length > 0),
		breadcrumbs: [
			{ name: 'Home', href: '/' },
			{ name: 'Shop', href: '/shop/' },
			{ name: member?.breadcrumbName ?? product.name, href: productPath(product.slug) },
		],
		source,
	};
}

/** ADR-0001 §2-§3: the shell copy of a found detail (every model's prices redacted; no stock is in the detail at all). */
export const shellBrandProductDetail = (d: BrandProductDetail): BrandProductDetail =>
	d.state === 'found' ? { ...d, product: redactModel(d.product), siblings: d.siblings.map(redactModel) } : d;

export const useBrandProductDetail = routeLoader$(async ({ params, status, url, headers }): Promise<BrandProductDetail | null> => {
	if (!hasView('route.product')) return null;
	const slug = productSlugOf(url.pathname, params);
	if (slug === null) return null;
	if (!slug || !SAFE_SLUG.test(slug)) {
		status(404);
		return MISSING;
	}
	const detail = await buildBrandProductDetail(slug);
	if (detail === 'unavailable') {
		// The API failed (not a 404): temporary, so 503 with Retry-After rather than "product not found".
		headers.set('Retry-After', '30');
		status(503);
		return MISSING;
	}
	if (detail.state === 'missing') {
		status(404);
		return MISSING;
	}
	return shellRender() ? shellBrandProductDetail(detail) : detail;
});

/** The branded product page's live values in the browser (ADR-0001): the same build for the slug, per request, no-store. Null on any
 *  failure (the view keeps its pending prices). */
export const readBrandProductDetail = server$(async function (slug: string): Promise<BrandProductDetail | null> {
	noStore(this);
	if (!hasView('route.product') || typeof slug !== 'string' || !SAFE_SLUG.test(slug)) return null;
	const detail = await buildBrandProductDetail(slug);
	return detail === 'unavailable' ? null : detail;
});

/** A 160-character plain-text description, cut at a word (as the base product head does). */
function plainDescription(html: string): string {
	const raw = stripHtml(html).replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
	if (raw.length <= 160) return raw;
	const truncated = raw.substring(0, 160);
	const lastSpace = truncated.lastIndexOf(' ');
	return (lastSpace > 80 ? truncated.substring(0, lastSpace) : truncated).replace(/[.,;:!?\s]+$/, '') + '…';
}

const NOT_FOUND_HEAD = { title: 'Product Not Found', description: 'This product could not be found.', noindex: true } as const;

/**
 * The branded product page's head. Missing: `Product Not Found` + noindex (the per-product copy never applies to a missing product).
 * Found: the routes.json detail product's title/description when declared, else the product's own; canonical, og:url, the breadcrumb
 * and the live product JSON-LD are platform-built; the declared static schemas (FAQPage) follow.
 */
export const brandProductHead = ({ resolveValue }: { resolveValue: (loader: unknown) => unknown }): DocumentHeadValue => {
	const detail = resolveValue(useBrandProductDetail) as BrandProductDetail | null;
	if (!detail || detail.state !== 'found') return createSEOHead(NOT_FOUND_HEAD) as DocumentHeadValue;
	const product = detail.product;
	const member = DETAIL_PRODUCTS.find((m) => m.slug === product.slug);
	const canonical = productUrl(product.slug);
	const jsonLd = resolveValue(useProductJsonLd) as JsonLdSchema | null;
	const schemas: JsonLdSchema[] = [
		generateBreadcrumbSchema([
			{ name: 'Home', url: `${siteUrl}/` },
			{ name: 'Shop', url: `${siteUrl}/shop/` },
			{ name: member?.breadcrumbName ?? product.name, url: canonical },
		]),
	];
	if (jsonLd) {
		const facts = withProductFacts(withCanonicalUrls(jsonLd, canonical), product, { siteOrigin: siteUrl, brandName: theme.storeName, facts: member?.facts });
		schemas.push(withAggregateRating(facts as Record<string, unknown>, product.rating) as JsonLdSchema);
	}
	for (const s of member?.schemas ?? []) schemas.push(s as unknown as JsonLdSchema);
	const image = product.images[0]?.url;
	return createSEOHead({
		title: member?.head?.title ?? product.name,
		description: member?.head?.description ?? (plainDescription(product.description.html) || `${product.name} - High quality product available at ${theme.storeName}`),
		image,
		canonical,
		ogUrl: canonical,
		ogType: 'product',
		productMeta: productOgMeta(jsonLd as Record<string, unknown> | null, product, theme.storeName),
		links: image ? generateImagePreloadLinks(image, 'productMain', ['avif']) : [],
		schemas,
	}) as DocumentHeadValue;
};
