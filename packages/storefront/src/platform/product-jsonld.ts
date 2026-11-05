// Platform-built commerce JSON-LD over the configurator products (routes.json shop.detailProducts). A brand declares facts as data
// (`facts.material`); every commerce field comes from the catalog model or the API's own product JSON-LD, never from brand code.
// Stock: the shop page's ProductGroup offers carry no availability (the page has no live stock read at render, and missing stock is
// never stated as in stock); the product page's availability stays the API's per-request value.
import { effectivePriceOf, type ModelProduct } from '~/platform/controllers/product-model';
import { stripHtml } from '~/utils/sanitize';
import type { JsonLdSchema } from '~/types/seo.types';
import { absoluteOn, withAbsoluteImages } from '~/platform/product-jsonld-light';

// Re-exported so existing importers (and the tests) keep one entry point; browser code imports product-jsonld-light directly.
export { absoluteOn, withAbsoluteImages, withoutOffers, jsonLdTextWithOffers, fillJsonLdOffers } from '~/platform/product-jsonld-light';

/** routes.json shop.detailProducts[].facts: plain product facts the catalog does not carry. */
export interface ProductFacts {
	material?: string;
}

const COLOR_GROUPS = new Set(['color', 'colour']);
const SIZE_GROUPS = new Set(['size']);
const VARIES_BY: Record<string, string> = { color: 'https://schema.org/color', size: 'https://schema.org/size' };
const NEW = 'https://schema.org/NewCondition';

const kindOf = (groupCode: string): 'color' | 'size' | null => (COLOR_GROUPS.has(groupCode) ? 'color' : SIZE_GROUPS.has(groupCode) ? 'size' : null);

const decimal = (cents: number) => (cents / 100).toFixed(2);

/** Catalog HTML as plain text: tags dropped, the text entities decoded (`&lt;`/`&gt;` stay encoded: never a raw `<` in a script). */
const plainText = (html: string): string =>
	stripHtml(html).replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;(?!lt;|gt;)/g, '&').trim();

/** The shared stem of every variant SKU (`RH17-01`, `RH17-02` → `RH17`), or null when they do not share one. */
export function skuStem(skus: readonly string[]): string | null {
	const stems = new Set(skus.map((s) => (s.includes('-') ? s.slice(0, s.lastIndexOf('-')) : '')));
	const [stem] = [...stems];
	return stems.size === 1 && stem ? stem : null;
}

/** Value names per kind, in the model's option order. */
function optionNames(model: ModelProduct): { color: string[]; size: string[] } {
	const out = { color: [] as string[], size: [] as string[] };
	for (const g of model.groups) {
		const kind = kindOf(g.code);
		if (kind) out[kind].push(...g.values.map((v) => v.name));
	}
	return out;
}

/** The shop page's ProductGroup for one configurator product: variants with price and options, no availability. */
/**
 * `variantUrls`: give each variant its own URL (`?<group>=<value>` per option, read back by the brand product view's
 * selectionFromQuery). Off when the product page cannot preselect from the query (no route.product view): every variant then
 * names the product URL.
 */
export function productGroupSchema(model: ModelProduct, ctx: { siteOrigin: string; brandName: string; facts?: ProductFacts; variantUrls?: boolean }): JsonLdSchema {
	const url = absoluteOn(ctx.siteOrigin, model.href);
	const groupIndex = new Map(model.groups.map((g) => [g.code, g] as const));
	const variesBy = model.groups.map((g) => kindOf(g.code)).filter((k): k is 'color' | 'size' => !!k).map((k) => VARIES_BY[k]);
	const stem = skuStem(model.variants.map((v) => v.sku));
	const hasVariant = model.variants.map((v) => {
		// The query names every option by its group code, as the product page reads it back (selectionFromQuery).
		const named: { color?: string; size?: string } = {};
		const query = new URLSearchParams();
		// Colour first (name and query), then the other options in model order, as product feeds and the legacy schema list them.
		const options = [...v.options].sort((a, b) => Number(kindOf(b.group) === 'color') - Number(kindOf(a.group) === 'color'));
		for (const pair of options) {
			const value = groupIndex.get(pair.group)?.values.find((x) => x.code === pair.value);
			if (!value) continue;
			query.set(pair.group, value.code);
			const kind = kindOf(pair.group);
			if (kind) named[kind] = value.name;
		}
		const variantUrl = ctx.variantUrls !== false && query.size ? `${url}?${query.toString()}` : url;
		const image = v.images[0]?.url ?? model.images[0]?.url;
		const price = effectivePriceOf(v);
		return {
			'@type': 'Product',
			name: [model.name, ...options.map((p) => groupIndex.get(p.group)?.values.find((x) => x.code === p.value)?.name).filter(Boolean)].join(' - '),
			sku: v.sku,
			...named,
			url: variantUrl,
			...(image ? { image: absoluteOn(ctx.siteOrigin, image) } : {}),
			// ADR-0001 DP-1: a shell model (prices pending) states no offer; the merchant feed stays the crawl source for prices.
			...(model.pricePending ? {} : { offers: { '@type': 'Offer', url: variantUrl, price: decimal(price), priceCurrency: model.currencyCode, itemCondition: NEW } }),
		};
	});
	return {
		'@context': 'https://schema.org',
		'@type': 'ProductGroup',
		name: model.name,
		url,
		...(stem ? { productGroupID: stem } : {}),
		brand: { '@type': 'Brand', name: ctx.brandName },
		...(ctx.facts?.material ? { material: ctx.facts.material } : {}),
		...(variesBy.length ? { variesBy } : {}),
		hasVariant,
	} as unknown as JsonLdSchema;
}

/**
 * The product page's API Product JSON-LD with the facts it lacks: brand and condition (when absent), the declared material, the
 * colour and size lists from the model, a plain-text description and absolute image URLs. Offers (price, availability) are untouched.
 */
export function withProductFacts(schema: JsonLdSchema, model: ModelProduct, ctx: { siteOrigin: string; brandName: string; facts?: ProductFacts }): JsonLdSchema {
	const s = { ...(withAbsoluteImages(schema, ctx.siteOrigin) as Record<string, unknown>) };
	if (typeof s.description === 'string' && s.description.includes('<')) s.description = plainText(s.description);
	if (ctx.facts?.material) s.material = ctx.facts.material;
	if (!s.itemCondition) s.itemCondition = NEW;
	const names = optionNames(model);
	if (names.color.length) s.color = names.color;
	if (names.size.length) s.size = names.size;
	if (!s.brand) s.brand = { '@type': 'Brand', name: ctx.brandName };
	return s as JsonLdSchema;
}

/** Open Graph `product:*` values for a product page. */
export interface ProductOgMeta {
	price?: string;
	currency?: string;
	brand: string;
	condition: 'new';
	/** Only from the request's live product JSON-LD (offers.availability); never from a snapshot. */
	availability?: 'in stock' | 'out of stock' | 'preorder' | 'backorder';
}

const OG_AVAILABILITY: Record<string, ProductOgMeta['availability']> = {
	InStock: 'in stock',
	OutOfStock: 'out of stock',
	SoldOut: 'out of stock',
	PreOrder: 'preorder',
	BackOrder: 'backorder',
};

/**
 * `product:*` for a product page: price and currency from the request's live product JSON-LD offer (else the catalog model's
 * lowest effective price), brand, condition new, and availability ONLY when that live JSON-LD states it (the API reads it per
 * request, no-store; the page is never prerendered or edge-cached). Without the live JSON-LD there is no availability tag.
 */
export function productOgMeta(liveJsonLd: Record<string, unknown> | null, model: ModelProduct, brandName: string): ProductOgMeta {
	const offer = liveJsonLd && typeof liveJsonLd.offers === 'object' && !Array.isArray(liveJsonLd.offers) ? (liveJsonLd.offers as Record<string, unknown>) : null;
	// ADR-0001 DP-1: a shell model's prices are pending (zeroed): never a price tag from them.
	const prices = model.pricePending ? [] : model.variants.map(effectivePriceOf).filter((n) => Number.isFinite(n) && n >= 0);
	const price = typeof offer?.price === 'string' || typeof offer?.price === 'number' ? Number(offer.price).toFixed(2) : prices.length ? decimal(Math.min(...prices)) : undefined;
	const currency = typeof offer?.priceCurrency === 'string' ? offer.priceCurrency : model.currencyCode;
	const avail = typeof offer?.availability === 'string' ? OG_AVAILABILITY[offer.availability.replace(/^https?:\/\/schema\.org\//, '')] : undefined;
	return { ...(price ? { price, currency } : {}), brand: brandName, condition: 'new', ...(avail ? { availability: avail } : {}) };
}

