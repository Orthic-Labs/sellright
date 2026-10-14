// Platform-built commerce JSON-LD over the configurator products (routes.json shop.detailProducts). A brand declares facts as data
// (`facts.material`); every commerce field comes from the catalog model or the API's own product JSON-LD, never from brand code.
// Stock: the shop page's ProductGroup offers carry no availability (the page has no live stock read at render, and missing stock is
// never stated as in stock); the product page's availability stays the API's per-request value.
import { effectivePriceOf, type ModelProduct } from '~/platform/controllers/product-model';
import { stripHtml } from '~/utils/sanitize';
import type { JsonLdSchema } from '~/types/seo.types';

/** routes.json shop.detailProducts[].facts: plain product facts the catalog does not carry. */
export interface ProductFacts {
	material?: string;
}

const COLOR_GROUPS = new Set(['color', 'colour']);
const SIZE_GROUPS = new Set(['size']);
const VARIES_BY: Record<string, string> = { color: 'https://schema.org/color', size: 'https://schema.org/size' };
const NEW = 'https://schema.org/NewCondition';

const kindOf = (groupCode: string): 'color' | 'size' | null => (COLOR_GROUPS.has(groupCode) ? 'color' : SIZE_GROUPS.has(groupCode) ? 'size' : null);

/** An absolute URL on the site for a catalog image or path: absolute stays, `/x` is site-rooted, a bare asset path is under /assets/. */
export function absoluteOn(siteOrigin: string, ref: string): string {
	if (/^https?:\/\//.test(ref)) return ref;
	if (ref.startsWith('/')) return `${siteOrigin}${ref}`;
	return `${siteOrigin}/assets/${ref}`;
}

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
		for (const pair of v.options) {
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
			name: [model.name, ...v.options.map((p) => groupIndex.get(p.group)?.values.find((x) => x.code === p.value)?.name).filter(Boolean)].join(' - '),
			sku: v.sku,
			...named,
			url: variantUrl,
			...(image ? { image: absoluteOn(ctx.siteOrigin, image) } : {}),
			offers: { '@type': 'Offer', url: variantUrl, price: decimal(price), priceCurrency: model.currencyCode, itemCondition: NEW },
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
	const s = { ...(schema as Record<string, unknown>) };
	if (typeof s.description === 'string' && s.description.includes('<')) s.description = plainText(s.description);
	if (typeof s.image === 'string') s.image = absoluteOn(ctx.siteOrigin, s.image);
	else if (Array.isArray(s.image)) s.image = s.image.map((i) => (typeof i === 'string' ? absoluteOn(ctx.siteOrigin, i) : i));
	if (ctx.facts?.material) s.material = ctx.facts.material;
	if (!s.itemCondition) s.itemCondition = NEW;
	const names = optionNames(model);
	if (names.color.length) s.color = names.color;
	if (names.size.length) s.size = names.size;
	if (!s.brand) s.brand = { '@type': 'Brand', name: ctx.brandName };
	return s as JsonLdSchema;
}
