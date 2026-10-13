// Brand views PR2 §6-§8: the branded product page's loader and head. Metadata only: no stock is read here (the controller makes the
// view's one live read in the browser). The route product and its siblings come from ONE catalog generation, or all of them from the
// live API, never a mix. With no `route.product` view this loader returns null without any I/O, and the route keeps today's loader
// and head untouched.
import { routeLoader$, type DocumentHeadValue } from '@qwik.dev/router';
import { hasView } from '~/platform/gateway';
import { DETAIL_PRODUCTS } from '~/platform/brand-data';
import { detailSet, productSlugOf, withCanonicalUrls } from '~/platform/product-detail-model';

export { detailSet, productSlugOf, withCanonicalUrls };
import { productPath, productUrl } from '~/platform/product-path';
import { buildModelProduct, type ModelProduct } from '~/platform/controllers/product-model';
import { readCatalogGeneration } from '~/services/catalog-snapshot';
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

const SAFE_SLUG = /^[a-z0-9][a-z0-9\-_]*$/;

export type BrandProductDetail =
	| { state: 'found'; product: ModelProduct; siblings: ModelProduct[]; breadcrumbs: { name: string; href: string }[]; source: 'manifest' | 'network' }
	| { state: 'missing' };

const MISSING: BrandProductDetail = { state: 'missing' };

/** Every product of `set` from one generation, or null when the generation is invalid or any file is missing. */
export async function modelsFromManifest(set: readonly { key: string; slug: string }[], read = readCatalogGeneration): Promise<ModelProduct[] | null> {
	const files = set.map((p) => `products/${p.slug}.json`);
	let gen: Awaited<ReturnType<typeof readCatalogGeneration<RawManifestProductDetail>>>;
	try {
		gen = await read<RawManifestProductDetail>(files);
	} catch {
		return null;
	}
	if (files.some((f) => !gen.files[f])) return null;
	try {
		return set.map((p, i) => {
			const raw = gen.files[files[i]] as RawManifestProductDetail;
			return buildModelProduct(normalizeManifestProductDetail(raw), { key: p.key, href: productPath(p.slug), ...manifestProductMeta(raw) });
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
			} catch {
				return null;
			}
		}),
	);
}

/** The branded product page's detail. Status 404 for an invalid slug, an unknown product and a product with no variants. */
export const useBrandProductDetail = routeLoader$(async ({ params, status, url }): Promise<BrandProductDetail | null> => {
	if (!hasView('route.product')) return null;
	const slug = productSlugOf(url.pathname, params);
	if (slug === null) return null;
	if (!slug || !SAFE_SLUG.test(slug)) {
		status(404);
		return MISSING;
	}
	const set = detailSet(slug);
	let source: 'manifest' | 'network' = 'manifest';
	let models: (ModelProduct | null)[] | null = await modelsFromManifest(set);
	if (!models) {
		source = 'network';
		models = await modelsFromLive(set);
	}
	const product = models[0];
	if (!product || product.variants.length === 0) {
		status(404);
		return MISSING;
	}
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
	if (jsonLd) schemas.push(withAggregateRating(withCanonicalUrls(jsonLd, canonical) as Record<string, unknown>, product.rating) as JsonLdSchema);
	for (const s of member?.schemas ?? []) schemas.push(s as unknown as JsonLdSchema);
	const image = product.images[0]?.url;
	return createSEOHead({
		title: member?.head?.title ?? product.name,
		description: member?.head?.description ?? (plainDescription(product.description.html) || `${product.name} - High quality product available at ${theme.storeName}`),
		image,
		canonical,
		ogUrl: canonical,
		ogType: 'product',
		links: image ? generateImagePreloadLinks(image, 'productMain', ['avif', 'webp']) : [],
		schemas,
	}) as DocumentHeadValue;
};
