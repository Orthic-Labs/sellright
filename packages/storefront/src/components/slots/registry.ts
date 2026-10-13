// A17: the typed slot registry. A slot is a named, optional mount point in a base component. A brand fills it by dropping
// `src/brand-slots/<slot-name>.tsx` whose default export is `component$<SlotProps<'<slot-name>'>>(...)`; the Vite plugin
// (vite-plugin.ts) rejects unknown file names, a default export that is not `component$`, and props not typed from this
// map. Slots receive data and QRLs; they never fetch (check-code-shape rejects fetch/server$ in L3 files).
// Brand views (plan §1): a slot's props are flat, `DeepReadonly<ViewData> & Actions`: JSON-shaped data and `on*$` QRLs, never a
// Signal, store, loader value or class instance. The controllers in src/platform/controllers build them.
import type { Component } from '@qwik.dev/core';
import type { AccountOrderSummary } from '~/sellright/types/account';
import type {
	Action,
	BlogListViewProps,
	BlogPostViewProps,
	ContactViewProps,
	ContentViewProps,
	DeepReadonly,
	HomeViewProps,
	ProductViewProps,
	ShellFooterProps,
	ShellViewProps,
	ShopViewProps,
} from '~/platform/views';

export interface SlotPropsMap {
	/** Cart drawer / checkout summary lines: a progress hint under the line list. No base fallback (renders nothing). */
	'cart.free-shipping-progress': {
		currencyCode: string;
		/** Cart subtotal in minor units (cents). */
		subtotalCents: number;
		lineCount: number;
		isCheckoutView: boolean;
		/** APP_STATE.shippingAddress.countryCode (null until known): a brand's country rule (e.g. a US-only free-shipping band). */
		countryCode: string | null;
		/** max(0, subtotal - discountTotal): the amount the threshold applies to (formula of components/cart/Cart.tsx). */
		discountedSubtotalCents: number;
	};
	/**
	 * Checkout order summary: the points-redemption control. Rendered only when the shopper is signed in and the program is
	 * enabled. Fallback: the base LoyaltyRedeem, which gets the same props. The route owns the redemption signal; the slot
	 * can only ask `onRedeemToggle$`.
	 */
	'checkout.loyalty-redemption': DeepReadonly<{
		/** srAccountLoyalty().available. */
		balance: number;
		/** The program's minimum redeemable points (keeps the base "minimum points" message). */
		minRedeemPoints: number;
		/** previewRedemption(available, available, discountableCents, program); null = nothing redeemable. */
		offer: { points: number; discountCents: number } | null;
		/** previewRedemption(redeemPoints, available, ...) of the route's own signal; null = nothing applied. */
		applied: { points: number; discountCents: number } | null;
		discountableCents: number;
		currencyCode: string;
	}> & {
		/** on = redeem `offer.points` (invalid when `offer` is null), off = redeem 0. */
		onRedeemToggle$: Action<[on: boolean]>;
	};
	/** Footer payment-icon row: extra badges after the card icons. The base ships a default file for its own provider badge. */
	'payment.badges': {
		placement: 'footer';
	};
	/** PDP price block: payment-plan widget under the price. The base ships a default file for its own provider widget. */
	'pdp.payment-widget': {
		/** The live unit price in minor units (cents) the shopper currently sees. */
		priceCents: number;
	};
	/** PDP: a guarantee / warranty trigger plus its modal. The slot owns its own open state. No base fallback. */
	'pdp.guarantee-modal': {
		productId: string;
		productName: string;
	};
	/** PDP: a back-in-stock / waitlist block. Data only: a brand with a waitlist service passes a link, not a fetch. No base fallback. */
	'pdp.waitlist': {
		productId: string;
		productName: string;
		soldOut: boolean;
		/** Optional hook the platform can supply once a waitlist endpoint exists; the slot never fetches itself. */
		onJoin$?: Action<[email: string]>;
	};
	/** Account order history: one order card. Fallback: the base card markup. */
	'account.order-card': {
		order: DeepReadonly<AccountOrderSummary>;
		href: string;
	};
	/** Account overview: a badge next to the loyalty balance. No base fallback. */
	'account.sustainability-badge': {
		orderCount: number;
		statsLoaded: boolean;
	};
	/** Legal pages: brand-owned copy for a named section. Fallback: neutral copy in the page. */
	'legal.copy': {
		section: LegalCopySection;
	};
	/** Site header. Fallback: the base header. Brands style the base header through tokens and CSS only. */
	'shell.header': DeepReadonly<Omit<ShellViewProps, 'onCartToggle$' | 'onLogin$' | 'onLogout$' | 'onAccount$'>> &
		Pick<ShellViewProps, 'onCartToggle$' | 'onLogin$' | 'onLogout$' | 'onAccount$'>;
	/** Site footer. Fallback: the base footer. */
	'shell.footer': DeepReadonly<ShellFooterProps>;
	/** Homepage. Fallback: the base homepage. */
	'route.home': DeepReadonly<Omit<HomeViewProps, 'onSubscribe$'>> & Pick<HomeViewProps, 'onSubscribe$'>;
	/** Static content pages (about, privacy, terms, returns, press, and the content paths a brand declares in routes.json). Fallback: the base page. */
	'route.content': DeepReadonly<ContentViewProps>;
	/** Blog list. Fallback: the base list. */
	'route.blog': DeepReadonly<BlogListViewProps>;
	/** One blog post, or its missing state (the 404 status is kept). Fallback: the base post page. */
	'route.blog-post': DeepReadonly<BlogPostViewProps>;
	/** Contact page with the platform-managed form. Fallback: the base contact page. */
	'route.contact': DeepReadonly<Omit<ContactViewProps, 'onSubmit$'>> & Pick<ContactViewProps, 'onSubmit$'>;
	/** The shop page: the listing plus the configurator (routes.json shop.detailProducts). Fallback: the base shop page. */
	'route.shop': DeepReadonly<Omit<ShopViewProps, ShopActionKey>> & Pick<ShopViewProps, ShopActionKey>;
	/** One product page, or its missing state (the 404 status is kept). Narrow on `state`. Fallback: the base product page. */
	'route.product': ProductSlotProps;
}

type ConfiguratorActionKey = 'onOptionSelect$' | 'onQuantityChange$' | 'onConsentChange$' | 'onAddToCart$' | 'onRetryStock$';
type ShopActionKey = ConfiguratorActionKey | 'onProductSelect$' | 'onInStockChange$';
type FoundProps = Extract<ProductViewProps, { state: 'found' }>;
type MissingProps = Extract<ProductViewProps, { state: 'missing' }>;
export type ProductSlotProps = (DeepReadonly<Omit<FoundProps, ConfiguratorActionKey>> & Pick<FoundProps, ConfiguratorActionKey>) | DeepReadonly<MissingProps>;

export type LegalCopySection = 'privacy.payment-processors';

export type SlotName = keyof SlotPropsMap;
export type SlotProps<K extends SlotName> = SlotPropsMap[K];
export type SlotComponent<K extends SlotName> = Component<SlotPropsMap[K]>;
export type SlotMap = { [K in SlotName]?: SlotComponent<K> };

/** Every slot name, in declaration order. Keep in step with SlotPropsMap (registry.test.ts checks the two agree). */
export const SLOT_NAMES = [
	'cart.free-shipping-progress',
	'checkout.loyalty-redemption',
	'payment.badges',
	'pdp.payment-widget',
	'pdp.guarantee-modal',
	'pdp.waitlist',
	'account.order-card',
	'account.sustainability-badge',
	'legal.copy',
	'shell.header',
	'shell.footer',
	'route.home',
	'route.content',
	'route.blog',
	'route.blog-post',
	'route.contact',
	'route.shop',
	'route.product',
] as const satisfies readonly SlotName[];

/** The only extension a slot file may have: a slot is a Qwik component, so it needs JSX. */
export const SLOT_FILE_EXTENSION = '.tsx';

export const isSlotName = (value: string): value is SlotName => (SLOT_NAMES as readonly string[]).includes(value);

/** `payment.badges.tsx` -> `payment.badges`; null when the file is not `<something>.tsx`. */
export function slotNameFromFile(fileName: string): string | null {
	return fileName.endsWith(SLOT_FILE_EXTENSION) ? fileName.slice(0, -SLOT_FILE_EXTENSION.length) : null;
}

/** The brand's component for a slot, or undefined when the brand supplied none (the mount renders its fallback). */
export function pickSlot<K extends SlotName>(map: SlotMap, name: K): SlotComponent<K> | undefined {
	return map[name] as SlotComponent<K> | undefined;
}
