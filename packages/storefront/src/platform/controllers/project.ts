// Brand views, plan §1 "Projection". Every value a slot or an L2 component receives from live state is built here, field by field
// from primitives. A projection never spreads or returns a store, loader value or nested source object. Dev and test deep-freeze
// (so a brand write throws); production rebuilds each projection in `useComputed$` at the call site, so a write only touches a
// discarded copy. The gateway (src/platform/gateway) then rebuilds what it receives from its fixed schema, so a projection shapes the data
// and the gateway guarantees detachment; scripts/check-l2-boundary.mjs (r14) only keeps an advisory diagnostic of call sites.
import { DEFAULT_CURRENCY } from '~/constants';
import type { AccountOrderSummary } from '~/sellright/types/account';
import type { Detached } from '~/sellright/types/live';
import type { SrStoreIdentity } from '~/utils/sellright';
import type { FacetWithValues } from '~/types';
import type { StoreTheme } from '~/theme/theme.config';
import type { BlogCard, DeepReadonly, FormState, ListingCard, PublicIdentity } from '~/platform/views';
import { productPath } from '~/platform/product-path';

/** True in dev and test builds: projections are deep-frozen there. Read at call time so a test can stub the mode. */
export const freezeEnabled = (): boolean => !!(import.meta.env.DEV || import.meta.env.MODE === 'test');

export function freezeDeep<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const key of Object.keys(value as object)) freezeDeep((value as Record<string, unknown>)[key]);
		Object.freeze(value);
	}
	return value;
}

/** Freezes in dev/test; a plain (already detached) copy in production. */
export const seal = <T>(value: T): DeepReadonly<T> => (freezeEnabled() ? freezeDeep(value) : value) as DeepReadonly<T>;

const isPlain = (v: object): boolean => {
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
};

/**
 * A detached deep copy of JSON-shaped data: primitives, arrays and plain objects only. Functions, class instances (a Signal, a Map)
 * and symbols are dropped, so a store proxy or a signal can never ride along. Used for the open-ended parts of a projection
 * (an order's nested lines); named projections below pick their fields explicitly.
 */
export function detach<T>(value: T): T {
	const copy = (v: unknown, depth: number): unknown => {
		if (v === null || v === undefined) return v;
		const t = typeof v;
		if (t === 'string' || t === 'number' || t === 'boolean') return v;
		if (t !== 'object' || depth > 12) return undefined;
		if (Array.isArray(v)) return v.map((x) => copy(x, depth + 1));
		if (!isPlain(v as object)) return undefined;
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
			const c = copy(x, depth + 1);
			if (c !== undefined) out[k] = c;
		}
		return out;
	};
	return copy(value, 0) as T;
}

export const projectIdentity = (identity: SrStoreIdentity): DeepReadonly<PublicIdentity> =>
	seal<PublicIdentity>({
		storeName: String(identity.storeName ?? ''),
		legalName: String(identity.legalName ?? ''),
		tagline: String(identity.tagline ?? ''),
		supportEmail: String(identity.supportEmail ?? ''),
		logoText: String(identity.logoText ?? ''),
		logoImageUrl: identity.logoImageUrl ?? null,
		siteOrigin: String(identity.siteOrigin ?? ''),
		social: {
			...(identity.social?.instagram ? { instagram: String(identity.social.instagram) } : {}),
			...(identity.social?.facebook ? { facebook: String(identity.social.facebook) } : {}),
			...(identity.social?.twitter ? { twitter: String(identity.social.twitter) } : {}),
			...(identity.social?.tiktok ? { tiktok: String(identity.social.tiktok) } : {}),
			...(identity.social?.youtube ? { youtube: String(identity.social.youtube) } : {}),
			...(((identity.social as { pinterest?: string } | undefined)?.pinterest) ? { pinterest: String((identity.social as { pinterest?: string }).pinterest) } : {}),
		},
	});

const projectPolicy = (p: { label: string; sub: string }) => ({ label: String(p.label), sub: String(p.sub) });

/** The identity's shipping/returns/payment policy blocks, field by field (a base component such as HomeHero gets plain data, never the loader value). */
export const projectPolicies = (policies: StoreTheme['policies']): StoreTheme['policies'] =>
	seal({ shipping: projectPolicy(policies.shipping), returns: projectPolicy(policies.returns), payment: projectPolicy(policies.payment) }) as StoreTheme['policies'];

/** The two policy blocks HomeHero shows, field by field. */
export const projectHeroPolicies = (policies: StoreTheme['policies']): Pick<StoreTheme['policies'], 'shipping' | 'returns'> =>
	seal({ shipping: projectPolicy(policies.shipping), returns: projectPolicy(policies.returns) }) as Pick<StoreTheme['policies'], 'shipping' | 'returns'>;

/** One account order summary, field by field (the API may add fields; the gateway schema accepts exactly these). */
export const projectOrder = (order: AccountOrderSummary): DeepReadonly<Detached<AccountOrderSummary>> =>
	seal({
		code: order.code,
		currency: order.currency,
		fulfillmentStatus: order.fulfillmentStatus,
		grandTotal: order.grandTotal,
		lines: order.lines,
		paymentStatus: order.paymentStatus,
		placedAt: order.placedAt ?? null,
		state: order.state,
		status: order.status,
	}) as DeepReadonly<Detached<AccountOrderSummary>>;

/** For `Filters`: the facet list as plain data, never the shop page's store. */
export const projectFacets = (facets: readonly FacetWithValues[]): FacetWithValues[] =>
	facets.map((f) => ({
		id: String(f.id),
		name: String(f.name),
		open: !!f.open,
		values: f.values.map((v) => ({ id: String(v.id), name: String(v.name), selected: !!v.selected })),
	}));

/** For `Filters`: the selected facet value ids as a plain array. */
export const projectFacetIds = (ids: readonly string[]): string[] => ids.map((id) => String(id));

/** The legacy `priceWithTax` union (number | {min,max} | {value}) down to one price, as Price/ProductCard did. */
export function legacyPriceToNumber(price: unknown): number | null {
	if (typeof price === 'number') return price;
	if (price && typeof price === 'object') {
		const p = price as { value?: unknown; min?: unknown };
		if (typeof p.value === 'number') return p.value;
		if (typeof p.min === 'number') return p.min;
	}
	return null;
}

interface LegacySearchItem {
	slug: string;
	productName?: string | null;
	productAsset?: { preview?: string | null } | null;
	priceWithTax?: unknown;
	inStock?: boolean;
}

/** The homepage's featured grid for a brand view: no stock fields (a brand never reads or interprets stock). */
export const projectFeatured = (items: readonly LegacySearchItem[]): ListingCard[] =>
	seal(
		items.map((item) => ({
			slug: String(item.slug),
			name: String(item.productName ?? ''),
			href: productPath(String(item.slug)),
			image: item.productAsset?.preview ? String(item.productAsset.preview) : null,
			priceCents: legacyPriceToNumber(item.priceWithTax) ?? 0,
			currencyCode: DEFAULT_CURRENCY,
		})),
	) as ListingCard[];

/** The homepage grid for the base `ProductCard`: its existing primitive props, built field by field (v3.1). */
export interface ProductTile {
	slug: string;
	name: string;
	image: string | null;
	price: number | null;
	inStock: boolean | undefined;
}
export const projectProductTiles = (items: readonly LegacySearchItem[]): ProductTile[] =>
	items.map((item) => ({
		slug: String(item.slug),
		name: String(item.productName ?? ''),
		image: item.productAsset?.preview ? String(item.productAsset.preview) : null,
		price: legacyPriceToNumber(item.priceWithTax),
		inStock: item.inStock,
	}));

interface FeatureProductSource {
	name: string;
	slug: string;
	category?: string | null;
	description?: string | null;
	featuredAsset?: { preview?: string | null } | null;
}
interface FeatureVariantSource {
	price?: number;
	priceWithTax?: number;
	customFields?: { salePrice?: number | null; preOrderPrice?: number | null; isPreOrder?: boolean } | null;
}

/** For `HomeTeeSection`: the featured product as plain data. */
export const projectFeatureProduct = (product: FeatureProductSource | null | undefined) =>
	product
		? {
				name: String(product.name),
				slug: String(product.slug),
				category: product.category ?? null,
				description: product.description ?? null,
				featuredAsset: product.featuredAsset?.preview ? { preview: String(product.featuredAsset.preview) } : null,
			}
		: null;

export const projectFeatureVariant = (variant: FeatureVariantSource | null | undefined) =>
	variant
		? {
				price: variant.price,
				priceWithTax: variant.priceWithTax,
				customFields: {
					salePrice: variant.customFields?.salePrice ?? null,
					preOrderPrice: variant.customFields?.preOrderPrice ?? null,
					isPreOrder: variant.customFields?.isPreOrder ?? false,
				},
			}
		: null;

/** For `Price`: native price props from a variant (regular price from `priceWithTax ?? price`, as the base homepage passed it). */
export const projectPrice = (variant: FeatureVariantSource | null | undefined) => ({
	price: legacyPriceToNumber(variant?.priceWithTax ?? variant?.price),
	salePrice: variant?.customFields?.salePrice ?? undefined,
	preOrderPrice: variant?.customFields?.preOrderPrice ?? undefined,
	isPreOrder: variant?.customFields?.isPreOrder ?? undefined,
});

/**
 * The cart line quantity options (v3.1): `1..max`, or `1..9` plus `'10+'` when more than ten are offered and the list is not expanded.
 * `max` = largest selectable quantity.
 */
export const projectQuantityOptions = (max: number, expanded: boolean): (number | string)[] => {
	if (max <= 10) return Array.from({ length: max }, (_, i) => i + 1);
	return expanded ? Array.from({ length: max }, (_, i) => i + 1) : [...Array.from({ length: 9 }, (_, i) => i + 1), '10+'];
};

export const projectFormState = (s: { status: 'idle' | 'sending' | 'success' | 'error'; message: string; turnstileRequired: boolean; turnstileReady: boolean }): FormState => ({
	status: s.status === 'sending' ? 'submitting' : s.status,
	message: s.status === 'error' && s.message ? s.message : null,
	turnstileRequired: s.turnstileRequired,
	turnstileReady: s.turnstileReady,
});

interface BlogSummarySource {
	slug: string;
	title: string;
	excerpt?: string | null;
	featuredImage?: { preview?: string | null } | null;
	publishDate?: string | null;
	createdAt?: string | null;
	readingTime?: number | null;
	tags?: readonly string[] | null;
}

/** publishDate ?? createdAt (the list date); readingTime keeps the adapter default of 1. */
export const projectBlogCard = (p: BlogSummarySource): BlogCard => ({
	slug: String(p.slug),
	title: String(p.title),
	excerpt: p.excerpt ? String(p.excerpt) : null,
	image: p.featuredImage?.preview ? String(p.featuredImage.preview) : null,
	publishedAt: p.publishDate || p.createdAt || null,
	readingTime: typeof p.readingTime === 'number' && p.readingTime > 0 ? p.readingTime : 1,
	href: `/blog/${String(p.slug)}/`,
	tags: [...(p.tags ?? [])].map(String),
});
