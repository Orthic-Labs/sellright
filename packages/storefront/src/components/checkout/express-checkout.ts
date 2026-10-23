// Express checkout at the top of checkout: Apple Pay / Google Pay through the card gateway's Express Checkout Element
// (ExpressCheckout.tsx mounts it; everything decidable without the browser SDK lives here so it is unit-tested).
//
// The wallet never decides money. Every amount it shows comes from the API's express quote for the destination the
// wallet reports (`getExpressQuote`); on confirm the order is created through the SAME path as PLACE ORDER (live stock
// read under the cart lock, POST /v1/shop/checkout with the quote's hash as consent, then the payment intent minted for
// the server's amount due with the wallet's total as `expectedAmount`). Any difference refuses the payment instead of
// charging a total the shopper did not see.
import type { ExpressQuote } from '~/sellright/types/checkout';

export interface ExpressCheckoutInputs {
	gatewayConfigured: boolean | null | undefined;
	publishableKey: string | null | undefined;
	currency: string | null | undefined;
	cartToken: string | null | undefined;
	cartEmpty: boolean;
	/** True while no order exists for this checkout view (no code, no resume, not placing or paying). */
	noOrderYet: boolean;
}

export interface ExpressCheckoutOptions {
	publishableKey: string;
	/** Lower-case ISO currency, as the card gateway's Elements expects. */
	currency: string;
	cartToken: string;
}

/** The gateway account an express element mounts for. A cart (and so a quote) may not exist yet: the element mounts
 *  first, so the gateway can report which wallets this device has, and the button shows only once a quote exists. */
export interface ExpressGateway {
	publishableKey: string;
	/** Lower-case ISO currency, as the card gateway's Elements expects. */
	currency: string;
}

/** Null: no card gateway, or no usable currency. */
export function expressGateway(i: { gatewayConfigured: boolean | null | undefined; publishableKey: string | null | undefined; currency: string | null | undefined }): ExpressGateway | null {
	const publishableKey = (i.publishableKey ?? '').trim();
	if (!i.gatewayConfigured || !publishableKey) return null;
	const currency = (i.currency ?? '').trim().toLowerCase();
	if (!/^[a-z]{3}$/.test(currency)) return null;
	return { publishableKey, currency };
}

/** Null hides express checkout: no gateway, no cart, an order already in progress. The button itself also stays hidden
 *  until the gateway reports an available wallet (see ExpressCheckout.tsx) — nothing is ever faked. */
export function expressCheckoutOptions(i: ExpressCheckoutInputs): ExpressCheckoutOptions | null {
	if (!i.cartToken || i.cartEmpty || !i.noOrderYet) return null;
	const gateway = expressGateway(i);
	return gateway ? { ...gateway, cartToken: i.cartToken } : null;
}

/** The button heights the card gateway accepts (Express Checkout Element `buttonHeight`, 40–55px; its default is 44). */
export const EXPRESS_BUTTON_HEIGHT = { min: 40, max: 55 } as const;

/** A brand's ADD TO CART height as the gateway can render it: rounded and clamped to its range; undefined keeps the default. */
export function expressButtonHeight(px: number | null | undefined): number | undefined {
	if (typeof px !== 'number' || !Number.isFinite(px) || px <= 0) return undefined;
	return Math.min(EXPRESS_BUTTON_HEIGHT.max, Math.max(EXPRESS_BUTTON_HEIGHT.min, Math.round(px)));
}

/**
 * The express row: Apple Pay, Google Pay, Link and Klarna wherever the gateway account and the device offer them; PayPal
 * and Amazon Pay never. Klarna in the Express Checkout Element takes the same `shippingAddressRequired`, `shippingRates`,
 * `shippingaddresschange` / `shippingratechange` and `confirm` flow as the wallets (Stripe documents no per-method
 * shipping restriction for it); Stripe requires a Klarna payment to confirm at exactly the pre-authorized amount, which
 * `x-expected-amount` already guarantees for every express payment.
 */
export const EXPRESS_PAYMENT_METHODS = { applePay: 'auto', googlePay: 'auto', link: 'auto', klarna: 'auto', paypal: 'never', amazonPay: 'never' } as const;

/** Wallets only (Apple Pay / Google Pay), for a slot with room for exactly one button (e.g. a phone's sticky add-to-cart bar). */
export const EXPRESS_WALLET_METHODS = { applePay: 'auto', googlePay: 'auto', link: 'never', klarna: 'never', paypal: 'never', amazonPay: 'never' } as const;

/** Express Checkout Element create options. The wallet always collects email, phone and a shipping address (checkout prices
 *  tax and shipping by destination, as the form does); every button type is the "Buy" call to action. `walletsOnly` keeps
 *  just Apple Pay / Google Pay in a single one-button row (no Link or Klarna, no overflow menu). */
export function expressElementOptions(o: { buttonHeight?: number | null; walletsOnly?: boolean } = {}) {
	const buttonHeight = expressButtonHeight(o.buttonHeight);
	return {
		emailRequired: true,
		phoneNumberRequired: true,
		shippingAddressRequired: true,
		paymentMethods: o.walletsOnly ? EXPRESS_WALLET_METHODS : EXPRESS_PAYMENT_METHODS,
		buttonType: { applePay: 'buy', googlePay: 'buy' },
		...(o.walletsOnly ? { layout: { maxColumns: 1, maxRows: 1, overflow: 'never' as const } } : {}),
		...(buttonHeight ? { buttonHeight } : {}),
	} as const;
}

/** The gateway's `ready` report, reduced to: does this device have a payment method the express row shows. */
export function hasExpressMethod(available: Partial<Record<'applePay' | 'googlePay' | 'link' | 'klarna' | 'paypal' | 'amazonPay', boolean>> | null | undefined): boolean {
	return !!available && !!(available.applePay || available.googlePay || available.link || available.klarna);
}

/** PDP buy-now: exactly one unit of the selected variant, or nothing when no complete variant is selected. */
export function buyNowItems(sku: string | null | undefined): { sku: string; quantity: 1 }[] | null {
	const s = (sku ?? '').trim();
	return s ? [{ sku: s, quantity: 1 }] : null;
}

/** Rate id shown for a cart with nothing to ship (checkout prices it with zero shipping and no method). */
export const NO_SHIPPING_RATE_ID = 'no-shipping';

export interface WalletRate { id: string; displayName: string; amount: number }

/** One server quote as the wallet sheet uses it. */
export interface WalletQuote {
	country: string;
	requiresShipping: boolean;
	shippingMethodCode: string | null;
	grandTotal: number;
	quoteHash: string;
	currency: string;
	rates: WalletRate[];
}

export function toWalletQuote(country: string, q: ExpressQuote): WalletQuote {
	const rates: WalletRate[] = q.requiresShipping
		? q.methods.map((m) => ({ id: m.code, displayName: m.name, amount: m.rate }))
		: [{ id: NO_SHIPPING_RATE_ID, displayName: 'No shipping required', amount: 0 }];
	// The wallet pre-selects the first rate: put the method the quote is priced with first.
	const selected = q.shippingMethodCode ?? NO_SHIPPING_RATE_ID;
	rates.sort((a, b) => (a.id === selected ? -1 : b.id === selected ? 1 : 0));
	return { country: country.toUpperCase(), requiresShipping: q.requiresShipping, shippingMethodCode: q.shippingMethodCode,
		grandTotal: q.cart.grandTotal, quoteHash: q.cart.quoteHash, currency: q.cart.currency.toLowerCase(), rates };
}

/** A quote the wallet may show: positive integer total and a server quote identity. */
export function isChargeableQuote(q: WalletQuote | null | undefined): q is WalletQuote {
	return !!q && Number.isSafeInteger(q.grandTotal) && q.grandTotal > 0 && /^[0-9a-f]{64}$/.test(q.quoteHash);
}

/** The wallet confirm event, reduced to what checkout needs (the gateway SDK's own type is structurally wider). */
export interface WalletAddress { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; postal_code?: string | null; country?: string | null }
export interface WalletConfirm {
	billingDetails?: { name?: string | null; email?: string | null; phone?: string | null; address?: WalletAddress | null };
	shippingAddress?: { name?: string | null; address?: WalletAddress | null };
	shippingRate?: { id?: string | null };
}

export interface ExpressOrderForm {
	items?: { sku: string; quantity: number }[];
	email: string;
	shippingAddress: Record<string, unknown>;
	billingAddress?: Record<string, unknown>;
	shippingMethodCode?: string;
	couponCodes?: string[];
	acceptedQuoteHash: string;
	redeemPoints?: number;
}

export type ConfirmRefusal = { ok: false; reason: 'fail' | 'invalid_shipping_address'; message: string };

const address = (name: string, a: WalletAddress | null | undefined, phone?: string | null) => ({
	fullName: name.trim(),
	line1: a?.line1 ?? '', line2: a?.line2 ?? '', city: a?.city ?? '',
	province: a?.state ?? '', postalCode: a?.postal_code ?? '', country: (a?.country ?? '').toUpperCase(),
	...(phone ? { phone } : {}),
});

/**
 * Build the order request from the wallet's authorized details, or refuse when they do not match the quote the wallet
 * showed (a different country or shipping rate than the last server quote means a different total).
 */
export function walletOrderForm(
	quote: WalletQuote | null,
	event: WalletConfirm,
	extra: { items?: { sku: string; quantity: number }[]; couponCodes?: string[]; redeemPoints?: number },
): ExpressOrderForm | ConfirmRefusal {
	if (!isChargeableQuote(quote)) return { ok: false, reason: 'fail', message: 'Your total could not be confirmed. Please try again.' };
	const ship = event.shippingAddress;
	const country = (ship?.address?.country ?? '').toUpperCase();
	if (!ship?.address?.line1 || country !== quote.country) {
		return { ok: false, reason: 'invalid_shipping_address', message: 'Your shipping address changed. Please try again.' };
	}
	const rateId = event.shippingRate?.id ?? (quote.requiresShipping ? null : NO_SHIPPING_RATE_ID);
	if (rateId !== (quote.shippingMethodCode ?? NO_SHIPPING_RATE_ID)) {
		return { ok: false, reason: 'fail', message: 'Your shipping option changed. Please try again.' };
	}
	const email = event.billingDetails?.email?.trim();
	if (!email) return { ok: false, reason: 'fail', message: 'An email address is required to place your order.' };
	const phone = event.billingDetails?.phone ?? null;
	const billing = event.billingDetails?.address;
	return {
		...(extra.items?.length ? { items: extra.items } : {}),
		email,
		shippingAddress: address(ship.name || event.billingDetails?.name || '', ship.address, phone),
		...(billing?.line1 ? { billingAddress: address(event.billingDetails?.name || ship.name || '', billing) } : {}),
		...(quote.shippingMethodCode ? { shippingMethodCode: quote.shippingMethodCode } : {}),
		...(extra.couponCodes ? { couponCodes: [...extra.couponCodes] } : {}),
		acceptedQuoteHash: quote.quoteHash,
		...(extra.redeemPoints && extra.redeemPoints > 0 ? { redeemPoints: extra.redeemPoints } : {}),
	};
}

/** What the page's order step reports back: the order is ready to pay at exactly the wallet's total, or it is not. */
export type ExpressOrderResult = { ok: true; clientSecret: string; code: string; receiptToken: string } | { ok: false; message: string };

export interface ExpressConfirmDeps {
	quote: () => WalletQuote | null;
	extra: () => { items?: { sku: string; quantity: number }[]; couponCodes?: string[]; redeemPoints?: number };
	/** The gateway's own validation of the wallet payment details (Elements `submit`); resolves an error message or null. */
	submit: () => Promise<string | null>;
	/** PLACE ORDER's path (live stock read, order POST, intent minted with `expectedAmount`). */
	placeOrder: (form: ExpressOrderForm, expectedAmount: number) => Promise<ExpressOrderResult>;
	/** Confirm the minted intent with the wallet payment; success navigates away (redirect), so it only returns an error. */
	confirm: (clientSecret: string, returnUrl: string) => Promise<string | null>;
	returnUrl: (code: string, receiptToken: string) => string;
}

/** The wallet's confirm, end to end. Resolves ok (the browser is being redirected to confirmation) or a refusal for the sheet. */
export async function runExpressConfirm(deps: ExpressConfirmDeps, event: WalletConfirm): Promise<{ ok: true } | ConfirmRefusal> {
	const quote = deps.quote();
	const form = walletOrderForm(quote, event, deps.extra());
	if ('ok' in form) return form;
	const submitError = await deps.submit();
	if (submitError) return { ok: false, reason: 'fail', message: submitError };
	const order = await deps.placeOrder(form, quote!.grandTotal);
	if (!order.ok) return { ok: false, reason: 'fail', message: order.message };
	const confirmError = await deps.confirm(order.clientSecret, deps.returnUrl(order.code, order.receiptToken));
	if (confirmError) return { ok: false, reason: 'fail', message: confirmError };
	return { ok: true };
}
