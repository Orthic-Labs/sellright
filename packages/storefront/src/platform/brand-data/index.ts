// The only importer of `virtual:sellright-brand-data` (plan §1). A missing head.json / routes.json means today's defaults:
// an empty spec and no declared content, no per-page head, the default blog page size.
import { brandHead, brandHosts, brandLicense, brandRoutes } from 'virtual:sellright-brand-data';
import type { BrandHeadSpec, StaticSchema } from '~/platform/head-resolve';
import type { DeclaredContent } from '~/platform/content-routes';

export interface BrandRoutes {
	version: 1;
	/** Legacy path -> live path, 301 (platform/legacy-redirects.ts): an exact path, or a prefix ending in `/*`. */
	redirects?: Record<string, string>;
	content?: DeclaredContent[];
	/** Exact paths rendered by route.content; absent selects all supported content mounts. */
	contentViewPaths?: string[];
	pages?: Record<string, { head?: { title?: string; description?: string; noindex?: boolean } }>;
	blog?: { pageSize?: number };
	/** Brand views PR2 §9: where product pages live. Default `/products/:slug/`. */
	productPath?: '/products/:slug/' | '/shop/:slug/';
	shop?: {
		/** The configurator's products (1-4), metadata only; each one's head copy applies only while the product is found. */
		detailProducts?: DetailProduct[];
		/** Query params that pick the shop's initial product (`?style=long`): the first param present wins. */
		productQuery?: { params: string[]; values: Record<string, string> };
		/** The base shop listing's merchandising order: these slugs first, in this order (within the in-stock grouping); others follow. */
		listingOrder?: string[];
		/** The base shop listing's price: the lowest (default) or `min - max` when the variants' prices differ. */
		priceDisplay?: 'min' | 'range';
	};
	operational?: { cartSeedPath?: string; analyticsPath?: string };
	/** The brand home view's spotlight: one product sold in place (the configurator's options, live stock and add). */
	home?: { spotlight?: { key: string; slug: string } };
	/** The base product page: a related-products row (catalog snapshot, same category) and per-product editorial content. */
	productPage?: { related?: boolean; content?: Record<string, ProductPageContent> };
	/** Plain-text copy for base components a brand does not replace with a view (no markup: rendered as text). */
	copy?: { cart?: { emptyTitle?: string; emptyBody?: string; /** The drawer's trust strip (1-3 items); default: the identity's shipping, returns and payment policies. */ trust?: string[] } };
	/** The configurator's cart drawer opens this long after a successful add (0, the default, opens it at once). */
	cart?: { openAfterAddMs?: number; /** The drawer's trust strip on narrow screens: one truncated line (default) or wrapped items. */ trustStrip?: 'truncate' | 'wrap' };
}

/** Plain-text editorial content of one product (routes.json productPage.content[slug]): a design note and spec-derived Q&A. */
export interface ProductPageContent {
	designNote?: string;
	faqs?: { q: string; a: string }[];
}

export interface DetailProduct {
	key: string;
	slug: string;
	head?: { title: string; description: string };
	breadcrumbName?: string;
	schemas?: StaticSchema[];
	/** Plain product facts the platform adds to its own commerce JSON-LD (platform/product-jsonld.ts). */
	facts?: { material?: string };
}

export const BRAND_HEAD: BrandHeadSpec = (brandHead as BrandHeadSpec | null) ?? {};
export const BRAND_ROUTES: BrandRoutes | null = (brandRoutes as BrandRoutes | null) ?? null;
export const BRAND_REDIRECTS: Readonly<Record<string, string>> = BRAND_ROUTES?.redirects ?? {};
export const DECLARED_CONTENT: readonly DeclaredContent[] = BRAND_ROUTES?.content ?? [];
export const DETAIL_PRODUCTS: readonly DetailProduct[] = BRAND_ROUTES?.shop?.detailProducts ?? [];
export const BRAND_COPY: NonNullable<BrandRoutes['copy']> = BRAND_ROUTES?.copy ?? {};
export const CART_OPEN_AFTER_ADD_MS: number = BRAND_ROUTES?.cart?.openAfterAddMs ?? 0;
export const CART_TRUST_STRIP_WRAP: boolean = BRAND_ROUTES?.cart?.trustStrip === 'wrap';
export const HOME_SPOTLIGHT: { key: string; slug: string } | null = BRAND_ROUTES?.home?.spotlight ?? null;
const LISTING_RANK = new Map((BRAND_ROUTES?.shop?.listingOrder ?? []).map((slug, i) => [slug, i] as const));
/** The merchandising rank of a slug (routes.json shop.listingOrder); unlisted slugs rank last. */
export const listingRank = (slug: string): number => LISTING_RANK.get(slug) ?? Number.MAX_SAFE_INTEGER;
export const SHOP_PRICE_RANGE: boolean = BRAND_ROUTES?.shop?.priceDisplay === 'range';
/** routes.json productPage.related: the base product page shows related products. */
export const PDP_RELATED: boolean = BRAND_ROUTES?.productPage?.related === true;
/** routes.json productPage.content for a slug, or null. */
export const productPageContent = (slug: string): ProductPageContent | null => BRAND_ROUTES?.productPage?.content?.[slug] ?? null;

/** src/brand/hosts.json (hosts.schema.json): one build served on several hosts, a variant per host. */
export interface BrandHosts {
	version: 1;
	/** Leading host labels ignored when matching (`store.` in `store.example.com`). */
	stripPrefixes?: string[];
	/** The host whose variant answers an unknown Host. */
	default: string;
	hosts: Record<string, HostVariantSpec>;
}

export interface HostVariantSpec {
	key: string;
	name: string;
	/** The wordmark in two parts; the second takes the accent. Default: [name, '']. */
	wordmark?: [string, string];
	/** The variant's canonical site (links back to it). */
	domain: string;
	/** The catalog collection the variant sells from. Default: the key. */
	collection?: string;
	/** CSS custom properties set on the variant root, in declaration order. */
	tokens: Record<string, string>;
}

/** src/brand/license.json (license.schema.json): brand data of the license commerce flow. */
export interface BrandLicense {
	version: 1;
	seller: { line: string; supportLocalPart: string };
	pausedAppKeys?: string[];
	legalNotice?: string;
	contracts?: Record<string, LicenseContract>;
	confirmationLegalLinks?: Record<string, LegalLinks>;
	/** Device management of issued licenses, served by an API plugin at `endpoint` (GET list, PATCH/DELETE `<endpoint>/<id>`). */
	devices?: { endpoint: string };
	/** A verified app-store purchase (`sourceName`) credited toward a license (`targetName`, sold as `sku`) of one app. */
	upgradeCredit?: { endpoint: string; appKey: string; sku: string; creditTermsVersion: string; sourceName: string; targetName: string; storeName: string };
}

export interface LicenseContract {
	acceptanceVersion: string;
	agreementStatement: string;
	documents: Array<{
		role: 'license' | 'eula' | 'acceptable_use' | 'product_schedule' | 'privacy_notice';
		id: string;
		version: string;
		sha256: string;
		url: string;
		treatment: 'agree' | 'acknowledge';
	}>;
}

export interface LegalLinks { privacy: string; terms: string; refund: string; contact: string }

export const BRAND_HOSTS: BrandHosts | null = (brandHosts as BrandHosts | null) ?? null;
export const BRAND_LICENSE: BrandLicense | null = (brandLicense as BrandLicense | null) ?? null;
