// Brand views gateway (docs/plans/2026-10-11-brand-views-gateway.md): the ONLY L1 access to presentation implementations (base L2
// components and brand slots). scripts/check-gateway.mjs keeps it that way: no other L1 file may import an L2/L3 module or the slot
// lookup, and here a raw import may only be handed to `gate`/`slotGate`/`gateValue`. Each handle's schema mirrors today's prop types
// (types.test.ts checks them against each other); each action prop lists the platform actions it accepts (actions.ts).
import RawCheckIcon from '~/components/icons/CheckIcon';
import RawCloseIcon from '~/components/icons/CloseIcon';
import RawEyeIcon from '~/components/icons/EyeIcon';
import RawEyeSlashIcon from '~/components/icons/EyeSlashIcon';
import RawGiftIcon from '~/components/icons/GiftIcon';
import RawHeartIcon from '~/components/icons/HeartIcon';
import RawHomeIcon from '~/components/icons/HomeIcon';
import RawLockClosedIcon from '~/components/icons/LockClosedIcon';
import RawLogoutIcon from '~/components/icons/LogoutIcon';
import RawMapPinIcon from '~/components/icons/MapPinIcon';
import RawPencilIcon from '~/components/icons/PencilIcon';
import RawPencilSquareIcon from '~/components/icons/PencilSquareIcon';
import RawPlusIcon from '~/components/icons/PlusIcon';
import RawShieldCheckIcon from '~/components/icons/ShieldCheckIcon';
import RawShoppingBagIcon from '~/components/icons/ShoppingBagIcon';
import RawTrashIcon from '~/components/icons/TrashIcon';
import RawXCircleIcon from '~/components/icons/XCircleIcon';
import RawXMarkIcon from '~/components/icons/XMarkIcon';
import { Button as RawButton } from '~/components/buttons/Button';
import { HighlightedButton as RawHighlightedButton } from '~/components/buttons/HighlightedButton';
import RawAlert from '~/components/alert/Alert';
import RawSuccess from '~/components/success/Success';
import { ErrorMessage as RawErrorMessage } from '~/components/error-message/ErrorMessage';
import { OrderProcessingModal as RawOrderProcessingModal } from '~/components/OrderProcessingModal';
import RawComingSoon from '~/components/coming-soon/ComingSoon';
import RawMaintenanceScreen from '~/components/maintenance/MaintenanceScreen';
import { QuantityDropdown as RawQuantityDropdown } from '~/components/ui/QuantityDropdown';
import RawProductCard from '~/components/products/ProductCard';
import RawPrice from '~/components/products/Price';
import { HomeHero as RawHomeHero } from '~/components/home/HomeHero';
import { HomeServiceSection as RawHomeServiceSection, HomeTrustBar as RawHomeTrustBar } from '~/components/home/HomeSocialSections';
import { HomeTeeSection as RawHomeTeeSection } from '~/components/home/HomeTeeSection';
import { STYLES as RAW_HOMEPAGE_STYLES } from '~/components/home/homepage-styles';
import RawShopFilters from '~/components/Filters';
import RawSearchFilters from '~/components/facet-filter-controls/Filters';
import RawFiltersButton from '~/components/filters-button/FiltersButton';
import { LoyaltyRedeem } from '~/components/loyalty/LoyaltyRedeem';
import type { JSXOutput } from '@qwik.dev/core';
import { action, gate, gateValue, hasView, optionalAction, slotGate } from './gate';
import { anyOf, arr, bool, html, lit, nul, num, obj, opt, str } from './schema';
import { ADD_RESULT } from './actions';

export { hasView };
export { platformAction, type ActionHandle, type ActionName } from './actions';

// ---------------------------------------------------------------------------------------------------- shared shapes

const ICON = obj({ forcedClass: opt(str) });
/** Every icon handle has this simple type (so icons can be listed and swapped, e.g. AccountNav's nav links). */
export type IconHandle = (props: { readonly forcedClass?: string }) => JSXOutput;
export const IDENTITY = obj({
	storeName: str,
	legalName: str,
	tagline: str,
	supportEmail: str,
	logoText: str,
	logoImageUrl: nul(str),
	siteOrigin: str,
	social: obj({ instagram: opt(str), facebook: opt(str), twitter: opt(str), tiktok: opt(str), youtube: opt(str), pinterest: opt(str) }),
});
const POLICY = obj({ label: str, sub: str });
const FACETS = arr(obj({ id: str, name: str, open: bool, values: arr(obj({ id: str, name: str, selected: bool })) }));
export const FORM_STATE = obj({ status: lit('idle', 'submitting', 'success', 'error'), message: nul(str), turnstileRequired: bool, turnstileReady: bool });
export const LISTING_CARD = obj({ slug: str, name: str, href: str, image: nul(str), priceCents: num, currencyCode: str });
export const BLOG_CARD = obj({ slug: str, title: str, excerpt: nul(str), image: nul(str), publishedAt: nul(str), readingTime: num, href: str, tags: arr(str) });
const REDEMPTION = nul(obj({ points: num, discountCents: num }));
export const ORDER_SUMMARY = obj({
	code: str,
	currency: str,
	fulfillmentStatus: lit('unfulfilled', 'partially_fulfilled', 'fulfilled', 'partially_delivered', 'delivered'),
	grandTotal: num,
	lines: num,
	paymentStatus: lit('pending', 'authorized', 'paid', 'partially_refunded', 'refunded', 'voided', 'failed', 'balance_due'),
	placedAt: nul(str),
	state: str,
	status: lit('open', 'completed', 'cancelled', 'archived'),
});

// ---------------------------------------------------------------------------------------------------- icons

export const CheckIcon: IconHandle = /*#__PURE__*/ gate('CheckIcon', RawCheckIcon, { data: ICON });
export const CloseIcon: IconHandle = /*#__PURE__*/ gate('CloseIcon', RawCloseIcon, { data: ICON });
export const EyeIcon: IconHandle = /*#__PURE__*/ gate('EyeIcon', RawEyeIcon, { data: ICON });
export const EyeSlashIcon: IconHandle = /*#__PURE__*/ gate('EyeSlashIcon', RawEyeSlashIcon, { data: ICON });
export const GiftIcon: IconHandle = /*#__PURE__*/ gate('GiftIcon', RawGiftIcon, { data: ICON });
export const HeartIcon: IconHandle = /*#__PURE__*/ gate('HeartIcon', RawHeartIcon, { data: ICON });
export const HomeIcon: IconHandle = /*#__PURE__*/ gate('HomeIcon', RawHomeIcon, { data: ICON });
export const LockClosedIcon: IconHandle = /*#__PURE__*/ gate('LockClosedIcon', RawLockClosedIcon, { data: ICON });
export const LogoutIcon: IconHandle = /*#__PURE__*/ gate('LogoutIcon', RawLogoutIcon, { data: ICON });
export const MapPinIcon: IconHandle = /*#__PURE__*/ gate('MapPinIcon', RawMapPinIcon, { data: ICON });
export const PencilIcon: IconHandle = /*#__PURE__*/ gate('PencilIcon', RawPencilIcon, { data: ICON });
export const PencilSquareIcon: IconHandle = /*#__PURE__*/ gate('PencilSquareIcon', RawPencilSquareIcon, { data: ICON });
export const PlusIcon: IconHandle = /*#__PURE__*/ gate('PlusIcon', RawPlusIcon, { data: ICON });
export const ShieldCheckIcon: IconHandle = /*#__PURE__*/ gate('ShieldCheckIcon', RawShieldCheckIcon, { data: ICON });
export const ShoppingBagIcon: IconHandle = /*#__PURE__*/ gate('ShoppingBagIcon', RawShoppingBagIcon, { data: ICON });
export const TrashIcon: IconHandle = /*#__PURE__*/ gate('TrashIcon', RawTrashIcon, { data: ICON });
export const XCircleIcon: IconHandle = /*#__PURE__*/ gate('XCircleIcon', RawXCircleIcon, { data: ICON });
export const XMarkIcon: IconHandle = /*#__PURE__*/ gate('XMarkIcon', RawXMarkIcon, { data: ICON });

// ---------------------------------------------------------------------------------------------------- buttons and messages

/**
 * Buttons take no caller children (L1 markup never crosses): `icon` + `text` are data and the gateway builds the children, an icon
 * followed by the text node exactly as the call sites wrote it (`<CheckIcon /> &nbsp; Save` is icon + ' &nbsp; Save').
 */
const BUTTON_ICON = lit('check', 'x-mark', 'x-circle', 'pencil', 'plus');
const BUTTON_ICONS = { check: CheckIcon, 'x-mark': XMarkIcon, 'x-circle': XCircleIcon, pencil: PencilIcon, plus: PlusIcon } as const;
const buttonChildren = (d: { icon?: keyof typeof BUTTON_ICONS; iconClass?: string; text: string }) => {
	const Icon = d.icon ? BUTTON_ICONS[d.icon] : null;
	return Icon ? [<Icon key="icon" forcedClass={d.iconClass} />, d.text] : d.text;
};

export const Button = /*#__PURE__*/ gate('Button', RawButton, {
	data: obj({ extraClass: opt(str), icon: opt(BUTTON_ICON), iconClass: opt(str), text: str }),
	actions: { onClick$: optionalAction('ui.press') },
	compose: (d) => ({ props: d.extraClass === undefined ? {} : { extraClass: d.extraClass }, children: buttonChildren(d) }),
});
export const HighlightedButton = /*#__PURE__*/ gate('HighlightedButton', RawHighlightedButton, {
	data: obj({ extraClass: opt(str), disabled: opt(bool), icon: opt(BUTTON_ICON), iconClass: opt(str), text: str }),
	actions: { onClick$: optionalAction('ui.press') },
	compose: (d) => ({
		props: { ...(d.extraClass === undefined ? {} : { extraClass: d.extraClass }), ...(d.disabled === undefined ? {} : { disabled: d.disabled }) },
		children: buttonChildren(d),
	}),
});

export const Alert = /*#__PURE__*/ gate('Alert', RawAlert, { data: obj({ message: str }) });
export const Success = /*#__PURE__*/ gate('Success', RawSuccess, { data: obj({ message: str }) });
export const ErrorMessage = /*#__PURE__*/ gate('ErrorMessage', RawErrorMessage, { data: obj({ heading: str, message: str }) });
export const OrderProcessingModal = /*#__PURE__*/ gate('OrderProcessingModal', RawOrderProcessingModal, {
	data: obj({ visible: bool, storeName: str }),
	actions: { onClose$: optionalAction('ui.press') },
});
export const ComingSoon = /*#__PURE__*/ gate('ComingSoon', RawComingSoon, { data: obj({ storeName: str }) });
export const MaintenanceScreen = /*#__PURE__*/ gate('MaintenanceScreen', RawMaintenanceScreen, { data: obj({ storeName: str }) });

// ---------------------------------------------------------------------------------------------------- cart, catalog, filters

export const QuantityDropdown = /*#__PURE__*/ gate('QuantityDropdown', RawQuantityDropdown, {
	data: obj({ id: str, value: num, options: arr(anyOf(num, str)), disabled: opt(bool), theme: opt(lit('dark', 'light')) }),
	actions: { onChange$: action('cart.quantity-select') },
});

/** The listing card. `inStock` is the value the page already holds (shop manifest / search result), passed through: no stock read here. */
export const ProductCard = /*#__PURE__*/ gate('ProductCard', RawProductCard, {
	data: obj({
		slug: str,
		name: opt(str),
		image: opt(nul(str)),
		price: opt(nul(num)),
		salePrice: opt(nul(num)),
		preOrderPrice: opt(nul(num)),
		isPreOrder: opt(bool),
		inStock: opt(bool),
		priority: opt(bool),
		skeleton: opt(bool),
		/** The product link (platform/product-path.ts); the card's own default is the /products/ path. */
		href: opt(str),
	}),
});
export const Price = /*#__PURE__*/ gate('Price', RawPrice, {
	data: obj({
		price: opt(nul(num)),
		salePrice: opt(nul(num)),
		preOrderPrice: opt(nul(num)),
		isPreOrder: opt(bool),
		forcedClass: opt(str),
		originalPriceClass: opt(str),
		currencyCode: opt(str),
	}),
});

export const ShopFilters = /*#__PURE__*/ gate('ShopFilters', RawShopFilters, {
	data: obj({ facetsWithValues: FACETS, facetValueIds: arr(str), searchTerm: opt(str) }),
	actions: { onFilterChange$: action('filters.value'), onSearchChange$: optionalAction('filters.search') },
});
export const SearchFilters = /*#__PURE__*/ gate('SearchFilters', RawSearchFilters, {
	data: obj({ showMenu: bool, facetsWithValues: FACETS }),
	actions: { onToggleMenu$: action('ui.press'), onFilterChange$: action('filters.value'), onOpenCloseFilter$: action('filters.value') },
});
export const FiltersButton = /*#__PURE__*/ gate('FiltersButton', RawFiltersButton, { data: obj({}), actions: { onToggleMenu$: action('ui.press') } });

// ---------------------------------------------------------------------------------------------------- homepage

export const homepageStyles: string = /*#__PURE__*/ gateValue('homepageStyles', RAW_HOMEPAGE_STYLES, str);
export const HomeHero = /*#__PURE__*/ gate('HomeHero', RawHomeHero, { data: obj({ storeName: str, tagline: str, policies: obj({ shipping: POLICY, returns: POLICY }) }) });
export const HomeTrustBar = /*#__PURE__*/ gate('HomeTrustBar', RawHomeTrustBar, { data: obj({ policies: obj({ shipping: POLICY, returns: POLICY, payment: POLICY }) }) });
export const HomeServiceSection = /*#__PURE__*/ gate('HomeServiceSection', RawHomeServiceSection, { data: obj({}) });
export const HomeTeeSection = /*#__PURE__*/ gate('HomeTeeSection', RawHomeTeeSection, {
	data: obj({
		/** The product link (platform/product-path.ts). */
		href: opt(str),
		product: opt(nul(obj({ name: str, slug: str, category: nul(str), description: nul(str), featuredAsset: nul(obj({ preview: str })) }))),
		variant: opt(
			nul(
				obj({
					price: opt(num),
					priceWithTax: opt(num),
					customFields: obj({ salePrice: nul(num), preOrderPrice: nul(num), isPreOrder: bool }),
				}),
			),
		),
	}),
});

// ---------------------------------------------------------------------------------------------------- brand slots

export const SHELL_HEADER_DATA = obj({
	identity: IDENTITY,
	pathname: str,
	isHome: bool,
	isCheckout: bool,
	isConfirmation: bool,
	isNavigating: bool,
	cartQuantity: num,
	cartOpen: bool,
	account: obj({ signedIn: bool, displayName: nul(str) }),
});
export const ShellHeaderView = /*#__PURE__*/ slotGate('shell.header', {
	data: SHELL_HEADER_DATA,
	actions: { onCartToggle$: action('shell.cart-toggle'), onLogin$: action('shell.login'), onLogout$: action('shell.logout'), onAccount$: action('shell.account') },
});
export const SHELL_FOOTER_DATA = obj({ identity: IDENTITY, paymentLabels: arr(str), year: num });
export const ShellFooterView = /*#__PURE__*/ slotGate('shell.footer', { data: SHELL_FOOTER_DATA });

export const CONTENT_DATA = obj({ identity: IDENTITY, pageKey: str, pathname: str });
export const ContentView = /*#__PURE__*/ slotGate('route.content', { data: CONTENT_DATA });
export const BLOG_LIST_DATA = obj({ identity: IDENTITY, posts: arr(BLOG_CARD), total: num, pageSize: num, hasMore: bool });
export const BlogListView = /*#__PURE__*/ slotGate('route.blog', { data: BLOG_LIST_DATA });
export const BLOG_POST_DATA = anyOf(
	obj({
		identity: IDENTITY,
		state: lit('found'),
		post: obj({
			slug: str,
			title: str,
			excerpt: nul(str),
			publishedAt: nul(str),
			authorName: nul(str),
			image: nul(str),
			tags: arr(str),
			readingTime: num,
			toc: arr(obj({ id: str, text: str })),
			body: html,
		}),
		related: arr(BLOG_CARD),
	}),
	obj({ identity: IDENTITY, state: lit('missing') }),
);
export const BlogPostView = /*#__PURE__*/ slotGate('route.blog-post', { data: BLOG_POST_DATA });
export const CONTACT_DATA = obj({ identity: IDENTITY, form: FORM_STATE });
export const ContactView = /*#__PURE__*/ slotGate('route.contact', { data: CONTACT_DATA, actions: { onSubmit$: action('contact.submit') } });

export const FREE_SHIPPING_DATA = obj({
	currencyCode: str,
	subtotalCents: num,
	lineCount: num,
	isCheckoutView: bool,
	countryCode: nul(str),
	discountedSubtotalCents: num,
});
export const FreeShippingProgressView = /*#__PURE__*/ slotGate('cart.free-shipping-progress', { data: FREE_SHIPPING_DATA });
export const LOYALTY_DATA = obj({ balance: num, minRedeemPoints: num, offer: REDEMPTION, applied: REDEMPTION, discountableCents: num, currencyCode: str });
/** Fallback: the base LoyaltyRedeem (L1), given the same validated props. */
export const LoyaltyRedemptionView = /*#__PURE__*/ slotGate('checkout.loyalty-redemption', { data: LOYALTY_DATA, actions: { onRedeemToggle$: action('loyalty.redeem-toggle') } }, LoyaltyRedeem);
export const PaymentBadgesView = /*#__PURE__*/ slotGate('payment.badges', { data: obj({ placement: lit('footer') }) });
export const PaymentWidgetView = /*#__PURE__*/ slotGate('pdp.payment-widget', { data: obj({ priceCents: num }) });
export const GuaranteeModalView = /*#__PURE__*/ slotGate('pdp.guarantee-modal', { data: obj({ productId: str, productName: str }) });
export const WaitlistView = /*#__PURE__*/ slotGate('pdp.waitlist', {
	data: obj({ productId: str, productName: str, soldOut: bool }),
	actions: { onJoin$: optionalAction('pdp.waitlist-join') },
});
export const OrderCardView = /*#__PURE__*/ slotGate('account.order-card', { data: obj({ order: ORDER_SUMMARY, href: str }) });
export const SustainabilityBadgeView = /*#__PURE__*/ slotGate('account.sustainability-badge', { data: obj({ orderCount: num, statsLoaded: bool }) });
export const LegalCopyView = /*#__PURE__*/ slotGate('legal.copy', { data: obj({ section: lit('privacy.payment-processors') }) });

// ---------------------------------------------------------------------------------------------------- PR2: shop and product views
// docs/plans/2026-10-11-brand-views-pr2.md §2. Detail is metadata only; `availability` is `in-stock` only from a live read of the
// current view (platform/controllers/product-model.ts). The gateway has no record type, so every map is an array of pairs.

const AVAILABILITY = lit('unchecked', 'loading', 'in-stock', 'out-of-stock', 'error');
const VIEW_IMAGE = obj({ url: str, alt: nul(str) });
const PRICE_RANGE = obj({ minCents: num, maxCents: num });
export const VIEW_PRODUCT = obj({
	key: str,
	slug: str,
	name: str,
	href: str,
	description: html,
	images: arr(VIEW_IMAGE),
	optionGroups: arr(obj({ code: str, name: str, values: arr(obj({ code: str, name: str, availability: AVAILABILITY })) })),
	variants: arr(
		obj({
			sku: str,
			name: str,
			options: arr(obj({ group: str, value: str })),
			priceCents: num,
			salePriceCents: nul(num),
			preOrderPriceCents: nul(num),
			isPreOrder: bool,
			shipDate: nul(str),
			images: arr(VIEW_IMAGE),
			availability: AVAILABILITY,
		}),
	),
	priceRange: PRICE_RANGE,
	currencyCode: str,
	availability: AVAILABILITY,
	rating: nul(obj({ average: num, count: num })),
	productId: nul(str),
});
export const PRODUCT_SUMMARY = obj({ key: str, slug: str, name: str, href: str, image: nul(str), priceRange: PRICE_RANGE, currencyCode: str });
export const VIEW_SELECTION = obj({ productKey: nul(str), options: arr(obj({ group: str, value: nul(str) })), variantSku: nul(str), quantity: num, preOrderConsent: bool });
export const PURCHASE = obj({
	stock: lit('unchecked', 'loading', 'ready', 'error'),
	eligible: bool,
	reason: nul(lit('select-product', 'select-options', 'stock-loading', 'out-of-stock', 'in-cart-limit', 'stock-error', 'consent-required', 'adding')),
	adding: bool,
	last: nul(ADD_RESULT),
	inCartQuantity: num,
	maxQuantity: num,
});
const LISTING_ITEM = obj({ slug: str, name: str, href: str, image: nul(str), priceCents: num, currencyCode: str, availability: lit('in-stock', 'out-of-stock') });

export const SHOP_DATA = obj({
	identity: IDENTITY,
	listing: arr(LISTING_ITEM),
	inStockOnly: bool,
	detail: arr(VIEW_PRODUCT),
	detailStatus: lit('ok', 'partial', 'unavailable'),
	selection: VIEW_SELECTION,
	purchase: PURCHASE,
});
const CONFIGURATOR_ACTIONS = {
	onOptionSelect$: action('configurator.option-select'),
	onQuantityChange$: action('configurator.quantity'),
	onConsentChange$: action('configurator.consent'),
	onAddToCart$: action('configurator.add'),
	onRetryStock$: action('configurator.retry-stock'),
} as const;
export const HOME_DATA = obj({
	identity: IDENTITY,
	newsletter: FORM_STATE,
	featured: arr(LISTING_CARD),
	spotlight: nul(obj({ product: VIEW_PRODUCT, selection: VIEW_SELECTION, purchase: PURCHASE })),
});
export const HomeView = /*#__PURE__*/ slotGate('route.home', { data: HOME_DATA, actions: { ...CONFIGURATOR_ACTIONS, onSubscribe$: action('home.subscribe') } });
export const ShopView = /*#__PURE__*/ slotGate('route.shop', {
	data: SHOP_DATA,
	actions: { ...CONFIGURATOR_ACTIONS, onProductSelect$: action('configurator.product-select'), onInStockChange$: action('shop.in-stock') },
});

export const PRODUCT_FOUND_DATA = obj({
	identity: IDENTITY,
	state: lit('found'),
	product: VIEW_PRODUCT,
	siblings: arr(PRODUCT_SUMMARY),
	selection: VIEW_SELECTION,
	purchase: PURCHASE,
	breadcrumbs: arr(obj({ name: str, href: str })),
});
export const PRODUCT_MISSING_DATA = obj({ identity: IDENTITY, state: lit('missing'), shopHref: str });
/** `route.product`, found: the product, its siblings (no stock), the purchase state and the configurator actions. */
export const ProductView = /*#__PURE__*/ slotGate('route.product', { data: PRODUCT_FOUND_DATA, actions: CONFIGURATOR_ACTIONS });
/** `route.product`, missing (status 404): same slot, no actions, no controller and no stock read behind it. */
export const ProductMissingView = /*#__PURE__*/ slotGate('route.product', { data: PRODUCT_MISSING_DATA });
