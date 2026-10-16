// Brand views PR2 §6-§9: pure helpers of the branded product page (no Qwik, no I/O), shared by product-detail.ts and its tests.
import { DETAIL_PRODUCTS, type DetailProduct } from '~/platform/brand-data';
import { PRODUCT_PREFIX } from '~/platform/product-path';
import type { JsonLdSchema } from '~/types/seo.types';

/** The slug of a product route request, or null when this request is not on the configured product path. */
export function productSlugOf(pathname: string, params: Record<string, string>): string | null {
	if (pathname.split('/')[1] !== PRODUCT_PREFIX) return null;
	const raw = params.slug ?? '';
	return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/** The set read for a route slug: the route product first, then (for a configurator member) the other members. */
export function detailSet(slug: string, members: readonly DetailProduct[] = DETAIL_PRODUCTS): { key: string; slug: string }[] {
	const own = members.find((m) => m.slug === slug);
	if (!own) return [{ key: slug, slug }];
	return [own, ...members.filter((m) => m !== own)].map((m) => ({ key: m.key, slug: m.slug }));
}

/** The API's product JSON-LD with its own URLs pointed at this storefront's canonical (price and availability untouched). */
export function withCanonicalUrls(schema: JsonLdSchema, canonical: string): JsonLdSchema {
	const s = { ...(schema as Record<string, unknown>) };
	if (typeof s.url === 'string' && s.url !== canonical) s.url = canonical;
	const offers = s.offers;
	if (offers && typeof offers === 'object' && !Array.isArray(offers) && typeof (offers as Record<string, unknown>).url === 'string') s.offers = { ...(offers as Record<string, unknown>), url: canonical };
	return s as JsonLdSchema;
}

