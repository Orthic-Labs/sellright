// Brand views, plan §2.3: the PUBLIC platform surface for brand code (layers.json platformApi.public). Prop and result types
// for the view slots, plus the few presentation primitives a brand may use. Every export is a type, a definition in
// src/platform/**, or a reviewed re-export named in layers.json platformApi.reexports (scripts/check-imports.mjs r5,
// proven by src/platform/public-surface.test.ts). Slot props are flat: DeepReadonly<ViewData> & Actions.
import type { QRL } from '@qwik.dev/core';
import { formatPrice } from '~/utils/price-format';

export { Link } from '@qwik.dev/router';
export { OptimizedImage } from '~/components/ui/LazyImage';
export { RichContent } from '~/platform/widgets/RichContent';
export { TurnstileMount } from '~/platform/widgets/TurnstileMount';
export { RestockForm } from '~/platform/widgets/RestockForm';
export type { RestockFormProps } from '~/platform/widgets/RestockForm';
export { YouTubeFacade } from '~/platform/widgets/YouTubeFacade';
export type { YouTubeFacadeProps } from '~/platform/widgets/YouTubeFacade';
export { default as VerificationButton } from '~/components/verification/VerificationButton';
export type { SanitizedHtml } from '~/platform/sanitized';
import type { SanitizedHtml } from '~/platform/sanitized';

/** Pure money formatting for display (minor units in, locale string out). */
export const formatMoney = (cents: Cents, currencyCode?: string): string => formatPrice(cents, currencyCode);

export type Cents = number;

/** Arguments are primitives; the controller validates them against its own state before applying anything. */
export type ActionResult = { ok: true } | { ok: false; reason: 'invalid' | 'busy' | 'disposed' | 'error' };
export type Action<A extends unknown[] = [], R = ActionResult> = QRL<(...args: A) => Promise<R>>;

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer U)[]
		? readonly DeepReadonly<U>[]
		: T extends object
			? { readonly [K in keyof T]: DeepReadonly<T[K]> }
			: T;

export interface PublicIdentity {
	storeName: string;
	legalName: string;
	tagline: string;
	supportEmail: string;
	logoText: string;
	logoImageUrl: string | null;
	siteOrigin: string;
	social: { instagram?: string; facebook?: string; twitter?: string; tiktok?: string; youtube?: string; pinterest?: string };
}

/** Sources: identity loader; useLocation(); appState.showCart/customer; cart lines (components/header/header.tsx). */
export interface ShellViewProps {
	identity: PublicIdentity;
	pathname: string;
	isHome: boolean;
	isCheckout: boolean;
	isConfirmation: boolean;
	isNavigating: boolean;
	cartQuantity: number;
	cartOpen: boolean;
	account: { signedIn: boolean; displayName: string | null };
	/** useCartToggle: opening the cart always runs the live stock refresh. */
	onCartToggle$: Action;
	onLogin$: Action;
	onLogout$: Action;
	onAccount$: Action;
}
export interface ShellFooterProps {
	identity: PublicIdentity;
	/** Provider-neutral labels from platform/payments/labels.ts. */
	paymentLabels: string[];
	year: number;
}

export interface ContentViewProps {
	identity: PublicIdentity;
	pageKey: string;
	pathname: string;
	/** Optional runtime editorial summary; null keeps the brand's existing fallback. */
	reviewSummary?: { score: string; count: string; reviews: { text: string; name: string }[] } | null;
}

export interface FormState {
	status: 'idle' | 'submitting' | 'success' | 'error';
	message: string | null;
	turnstileRequired: boolean;
	turnstileReady: boolean;
}
export type FormResult = { ok: true } | { ok: false; reason: 'invalid' | 'busy' | 'turnstile' | 'server' | 'disposed' };

export interface ListingCard {
	slug: string;
	name: string;
	href: string;
	image: string | null;
	priceCents: Cents;
	currencyCode: string;
}

export interface HomeViewProps extends ConfiguratorActions {
	identity: PublicIdentity;
	newsletter: FormState;
	featured: ListingCard[];
	/**
	 * routes.json home.spotlight: the one product the home view sells in place, with the configurator's selection and purchase state
	 * (its stock is the view's own live read, like the shop's); null when none is declared or the product is not found. The
	 * configurator actions act on it. With no spotlight there is no product: option and quantity calls are `invalid`, the
	 * add is rejected `not-eligible` and nothing is requested.
	 */
	spotlight: HomeSpotlight | null;
	onSubscribe$: Action<[email: string, honeypot: string], FormResult>;
}
export interface HomeSpotlight {
	product: ViewProduct;
	selection: ViewSelection;
	purchase: PurchaseState;
}

export interface BlogCard {
	slug: string;
	title: string;
	excerpt: string | null;
	image: string | null;
	/** publishDate ?? createdAt; null = the view omits the date. */
	publishedAt: string | null;
	/** Minutes (adapter default 1). */
	readingTime: number;
	href: string;
	tags: string[];
}
export interface BlogListViewProps {
	identity: PublicIdentity;
	posts: BlogCard[];
	total: number;
	pageSize: number;
	hasMore: boolean;
}
export type BlogPostViewProps = { identity: PublicIdentity } & (
	| {
			state: 'found';
			post: {
				slug: string;
				title: string;
				excerpt: string | null;
				publishedAt: string | null;
				authorName: string | null;
				image: string | null;
				tags: string[];
				readingTime: number;
				/** Checked against the final sanitised body: every id exists in it. */
				toc: { id: string; text: string }[];
				body: SanitizedHtml;
			};
			related: BlogCard[];
	  }
	| { state: 'missing' }
);

export interface ContactViewProps {
	identity: PublicIdentity;
	form: FormState;
	onSubmit$: Action<[name: string, email: string, subject: string, message: string, honeypot: string], FormResult>;
}

// ---------------------------------------------------------------------------------------------------- PR2: shop and product views
// docs/plans/2026-10-11-brand-views-pr2.md §2. Detail is metadata only: every variant starts `unchecked`, and only a live read of the
// current view can make it `in-stock`. A brand reads availability, it never decides it.

export { ProductReviewsWidget } from '~/platform/widgets/ProductReviewsWidget';
export { LoyaltyEarnWidget } from '~/platform/widgets/LoyaltyEarnWidget';
export { ExpressBuyButtons } from '~/platform/widgets/ExpressBuyButtons';
export type { ExpressBuyButtonsProps } from '~/platform/widgets/ExpressBuyButtons';
export { PayLaterMessaging } from '~/platform/widgets/PayLaterMessaging';
export type { PayLaterMessagingProps } from '~/platform/widgets/PayLaterMessaging';

/** `in-stock` only from a live response of the current view; anything else (not read yet, failed, absent) is not purchasable. */
export type Availability = 'unchecked' | 'loading' | 'in-stock' | 'out-of-stock' | 'error';

export interface ViewImage {
	url: string;
	alt: string | null;
}
/** `code` is the value's slug (lower-case name, spaces to hyphens), stable for deep links and swatch maps; `name` is for display. */
export interface ViewOptionValue {
	code: string;
	name: string;
	/** Over the current partial selection: is any variant with this value (and the other selected values) in stock. */
	availability: Availability;
}
export interface ViewOptionGroup {
	code: string;
	name: string;
	values: ViewOptionValue[];
}
export interface ViewOptionPair {
	group: string;
	value: string;
}
export interface ViewVariant {
	sku: string;
	name: string;
	options: ViewOptionPair[];
	priceCents: Cents;
	salePriceCents: Cents | null;
	preOrderPriceCents: Cents | null;
	/** Catalog metadata for presentation and consent only: a pre-order is purchasable only while its live read is in stock. */
	isPreOrder: boolean;
	shipDate: string | null; shipDateLabel?: string | null;
	images: ViewImage[];
	availability: Availability;
}
export interface ViewProduct {
	key: string;
	slug: string;
	name: string;
	href: string;
	description: SanitizedHtml;
	images: ViewImage[];
	optionGroups: ViewOptionGroup[];
	variants: ViewVariant[];
	priceRange: { minCents: Cents; maxCents: Cents };
	currencyCode: string;
	/** `in-stock` when any variant's live read is in stock. */
	availability: Availability;
	rating: { average: number; count: number } | null;
	productId: string | null;
}
/** A sibling product on a product page: no stock. */
export interface ProductSummary {
	key: string;
	slug: string;
	name: string;
	href: string;
	image: string | null;
	priceRange: { minCents: Cents; maxCents: Cents };
	currencyCode: string;
}
export interface ViewSelection {
	productKey: string | null;
	options: { group: string; value: string | null }[];
	/** The variant the complete selection resolves to, or null. */
	variantSku: string | null;
	/** Always 1..max(1, purchase.maxQuantity). */
	quantity: number;
	preOrderConsent: boolean;
}
export type AddResult =
	| { status: 'added'; sku: string; quantity: number; lineQuantity: number }
	| { status: 'added-unavailable'; sku: string; quantity: number; lineQuantity: number; availableQuantity: number | null }
	| { status: 'rejected'; reason: 'invalid' | 'not-eligible' | 'busy' | 'disposed' | 'cart-changed' | 'cart-error' | 'error'; message: string | null };
export type PurchaseReason = 'select-product' | 'select-options' | 'stock-loading' | 'out-of-stock' | 'in-cart-limit' | 'stock-error' | 'consent-required' | 'adding';
export interface PurchaseState {
	stock: 'unchecked' | 'loading' | 'ready' | 'error';
	eligible: boolean;
	/** The first reason the focused selection cannot be added, or null when `eligible`. */
	reason: PurchaseReason | null;
	adding: boolean;
	last: AddResult | null;
	/** Units of the resolved variant already in the cart (display only). */
	inCartQuantity: number;
	maxQuantity: number;
}
export interface ShopListingItem {
	slug: string;
	name: string;
	href: string;
	image: string | null;
	priceCents: Cents;
	currencyCode: string;
	/** The listing's availability as the page holds it (manifest on load, live after the in-stock toggle). */
	availability: 'in-stock' | 'out-of-stock';
}

export interface ConfiguratorActions {
	/** group code, value code (null = deselect). Never reads stock. */
	onOptionSelect$: Action<[group: string, value: string | null]>;
	/** 1..purchase.maxQuantity, an integer. */
	onQuantityChange$: Action<[quantity: number]>;
	/** Only for a resolved pre-order variant. */
	onConsentChange$: Action<[accepted: boolean]>;
	/** The add's own server response decides the result; opens the cart drawer on `added*`. */
	onAddToCart$: Action<[], AddResult>;
	/** Only when `purchase.stock === 'error'`: one new live read. */
	onRetryStock$: Action;
}

export interface ShopViewData {
	identity: PublicIdentity;
	listing: ShopListingItem[];
	inStockOnly: boolean;
	/** The configurator's products (routes.json shop.detailProducts), metadata only. */
	detail: ViewProduct[];
	detailStatus: 'ok' | 'partial' | 'unavailable';
	selection: ViewSelection;
	purchase: PurchaseState;
}
export interface ShopViewProps extends ShopViewData, ConfiguratorActions {
	onProductSelect$: Action<[productKey: string]>;
	/** The listing's in-stock toggle: the only live listing read. */
	onInStockChange$: Action<[inStock: boolean]>;
}

export interface ProductFoundData {
	identity: PublicIdentity;
	state: 'found';
	product: ViewProduct;
	siblings: ProductSummary[];
	selection: ViewSelection;
	purchase: PurchaseState;
	breadcrumbs: { name: string; href: string }[];
}
export interface ProductMissingData {
	identity: PublicIdentity;
	state: 'missing';
	shopHref: string;
}
/** `route.product`: narrow on `state`. A missing product has no actions (and no stock read, no controller). */
export type ProductViewProps = (ProductFoundData & ConfiguratorActions) | ProductMissingData;
