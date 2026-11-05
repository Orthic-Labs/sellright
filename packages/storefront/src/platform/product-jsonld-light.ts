// Client-safe JSON-LD helpers (no catalog model, no DOMPurify): what browser bundles may import. The server-only builders
// (ProductGroup, product facts, OG meta) are in product-jsonld.ts; ADR-0001 DP-1's live offers fill is here so the client never
// pulls them in.
import type { JsonLdSchema } from '~/types/seo.types';

/** An absolute URL on the site for a catalog image or path: absolute stays, `/x` is site-rooted, a bare asset path is under /assets/. */
export function absoluteOn(siteOrigin: string, ref: string): string {
	if (/^https?:\/\//.test(ref)) return ref;
	if (ref.startsWith('/')) return `${siteOrigin}${ref}`;
	return `${siteOrigin}/assets/${ref}`;
}

/** The schema with its `image` (a string or a list) as absolute URLs on the site; crawlers resolve a bare key against the page. */
export function withAbsoluteImages(schema: JsonLdSchema, siteOrigin: string): JsonLdSchema {
	const image = (schema as Record<string, unknown>).image;
	if (typeof image === 'string') return { ...schema, image: absoluteOn(siteOrigin, image) } as JsonLdSchema;
	if (Array.isArray(image)) return { ...schema, image: image.map((i) => (typeof i === 'string' ? absoluteOn(siteOrigin, i) : i)) } as JsonLdSchema;
	return schema;
}

// ---------------------------------------------------------------------------------------------------- ADR-0001: offers off the shell

/** The product JSON-LD for the cacheable shell: `offers` (price, availability) removed; the browser fills them after its live read. */
export function withoutOffers<T>(schema: T): T {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
	const { offers: _offers, ...rest } = schema as Record<string, unknown>;
	void _offers;
	return rest as T;
}

/** The text of a JSON-LD script with live `offers` set on its Product (null when the text is not a Product schema). Pure. */
export function jsonLdTextWithOffers(text: string, offers: unknown): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>)['@type'] !== 'Product') return null;
	// `<` never appears raw inside a script element.
	return JSON.stringify({ ...(parsed as Record<string, unknown>), offers }).replace(/</g, '\\u003c');
}

/** Fills the page's Product JSON-LD `offers` from a live read (browser). Returns how many scripts were updated. */
export function fillJsonLdOffers(doc: Pick<Document, 'querySelectorAll'>, offers: unknown): number {
	if (!offers || typeof offers !== 'object') return 0;
	let n = 0;
	doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
		const next = jsonLdTextWithOffers(el.textContent ?? '', offers);
		if (next !== null) {
			el.textContent = next;
			n++;
		}
	});
	return n;
}
