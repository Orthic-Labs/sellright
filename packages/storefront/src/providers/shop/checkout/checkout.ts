/**
 * Native SellRight checkout — the ONE checkout backend for this storefront.
 * There is no legacy fallback and no "convert the local cart to an
 * order" step: the server-cart token (when one exists) IS the order's source
 * of truth, and POST /v1/shop/checkout creates the order directly from it.
 *
 * Every call here goes through `sellright()` (src/sellright/client.ts) —
 * openapi-fetch typed against the API's own OpenAPI document — never the
 * legacy hand-rolled `sr()` helper and never a legacy shape.
 */
import { sellright, idempotency, SellRightError } from '~/sellright/client';
import { storedAttribution } from '~/sellright/attribution';
import { orderTracking, pixelOppref, userDataEnabled } from '~/platform/controllers/user-data';
import { ConvertedCartError, type CartLockScope } from '~/services/CartService';
import type { CheckoutSnapshot } from '~/hooks/pre-submit-stock';
import type { ServerCart } from '~/sellright/types/cart';
import type {
	CheckoutRequest,
	CheckoutResponse,
	CheckoutConflictBody,
	ExpressQuote,
	ExpressQuoteRequest,
	PayResponse,
	PaymentIntentResponse,
	GatewayAttempt,
	GatewayVerifyResult,
	OrderSummary,
	ShopConfig,
	ShopShippingMethod,
} from '~/sellright/types/checkout';

export interface CheckoutForm {
	/** Bootstrap line items the request schema requires; the server cart's lines win. */
	items?: { sku: string; quantity: number }[];
	email?: string;
	shippingAddress?: Record<string, unknown>;
	billingAddress?: Record<string, unknown>;
	shippingMethodCode?: string;
	couponCode?: string;
	couponCodes?: string[];
	acceptedQuoteHash?: string;
	giftCardCode?: string;
	/** Points to redeem — the server re-validates against the customer's actual balance. */
	redeemPoints?: number;
}

export type CheckoutQuote = Pick<ServerCart, 'currency' | 'lines' | 'subtotal' | 'discountTotal' | 'shippingTotal' | 'taxTotal' | 'grandTotal' | 'couponCodes' | 'coupons' | 'quoteHash' | 'pricingIntent'>;
export class QuoteChangedError extends Error {
	constructor(readonly quote: CheckoutQuote, readonly quoteHash: string) {
		super('Your total changed. Review updated amounts & confirm this quote before placing your order.');
		this.name = 'QuoteChangedError';
	}
}

/** An HTTP 204 or a JSON `null` body reaches the caller as `data === undefined/null` with no thrown error. For every
 *  client call checkout depends on that is a FAILED call, never a value to read fields from. */
const nonEmpty = <T>(data: T | null | undefined, what: string): T => {
	if (data === null || data === undefined) throw new Error(`Empty ${what} response`);
	return data;
};

/**
 * R19-equivalent: one Idempotency-Key per checkout attempt. Retries of the
 * SAME attempt reuse it (the server replays the original order instead of
 * double-charging stock); a 409 `payload_mismatch` means the semantic payload
 * changed under a used key, so the key is rotated on the NEXT attempt only —
 * never reused across a materially different submit.
 */
let checkoutAttemptKey: string | null = null;
const attemptKey = (): string => (checkoutAttemptKey ??= crypto.randomUUID());
const resetAttemptKey = (): void => {
	checkoutAttemptKey = null;
};

/** True when POST /checkout was refused because a line's stock is gone (409 OUT_OF_STOCK). `placeOrder` rethrows its
 *  failures wrapped in a plain Error whose `cause` is the API error, so look at both. The caller must then re-read
 *  the live cart: its mirror still holds the stock it showed before the sale that emptied the shelf. */
export const isOutOfStockConflict = (error: unknown): boolean => {
	for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
		if (candidate instanceof SellRightError && candidate.status === 409 && candidate.code === 'OUT_OF_STOCK') return true;
	}
	return false;
};

/** True for the 409 shapes the cart itself produced (stale/converted/merged/
 *  revision_required) — as opposed to an unrelated 409 (e.g. out-of-stock or
 *  shipping-unavailable) that also carries a `cart` snapshot for display but
 *  isn't a cart-identity conflict. */
const isCartConflict = (
	body: CheckoutConflictBody | undefined,
): body is CheckoutConflictBody & { code: 'converted' | 'merged' | 'stale' | 'revision_required'; cart: NonNullable<CheckoutConflictBody['cart']> } =>
	!!body && typeof body.revision === 'number' && !!body.cart &&
	(body.code === 'converted' || body.code === 'merged' || body.code === 'stale' || body.code === 'revision_required');

/**
 * Create the order (server-priced) from the sr_cart token. The server is
 * authoritative — its cart lines win and the client item list is only the
 * bootstrap value the schema requires. Conversion is a non-append mutation:
 * `expectedRevision` echoes the revision of `snapshot`, the live read the
 * pre-submit stock check just validated (mismatch → 409 `stale` + the current
 * cart snapshot, which is adopted into the local mirror; the next attempt must
 * run a fresh validation). There is no tokenless submit and no second cart
 * read here: the validated snapshot is the only source of token and revision.
 *
 * Runs inside the cart lock: `scope` is the capability `CartService.withLock`
 * handed the caller, so conflict handling never re-acquires the lock. Every
 * local effect is bound to `snapshot.token`, the cart that was submitted.
 * A converted cart creates no order — it is resumed (see `resumeConverted`),
 * so it is refused here without a POST and its token is kept.
 */
export const placeOrder = async (form: CheckoutForm, snapshot: CheckoutSnapshot, scope: CartLockScope): Promise<CheckoutResponse> => {
	if (!snapshot || !snapshot.token || typeof snapshot.revision !== 'number') {
		throw new Error('Your cart could not be verified — please review it and try again.');
	}
	if (snapshot.status === 'merged') {
		// This token's lines already moved into the customer's cart at login —
		// falling back to the client item list here would double-submit them.
		scope.retire(snapshot.token);
		throw new Error('Your cart was merged into your account — please re-add your items.');
	}
	if (snapshot.status === 'converted') throw new ConvertedCartError();
	// A live read validates stock; it never grants consent to changed money.
	if (snapshot.quoteHash && form.acceptedQuoteHash !== snapshot.quoteHash && snapshot.quote) {
		throw new QuoteChangedError(snapshot.quote, snapshot.quoteHash);
	}

	// Landing UTM + oppref (consent-gated, last touch this session); stored on the order, never part of its idempotency fingerprint.
	const landing = storedAttribution();
	// #375: the OpenAI pixel's own 30-day __oppref cookie fills in when this tab's landing carried none.
	const oppref = userDataEnabled() && !landing?.oppref ? pixelOppref() : null;
	const attribution = landing || oppref ? { ...landing, ...(oppref ? { oppref: oppref.slice(0, 256) } : {}) } : null;
	// #375: ad match keys for the server-side conversion (pixel __obref, first-party visitor id).
	const tracking = userDataEnabled() ? orderTracking() : null;
	const body: CheckoutRequest = {
		items: form.items && form.items.length ? form.items : [{ sku: '__cart__', quantity: 1 }],
		email: form.email,
		shippingAddress: form.shippingAddress,
		billingAddress: form.billingAddress,
		shippingMethodCode: form.shippingMethodCode,
		couponCode: form.couponCode,
		couponCodes: form.couponCodes,
		acceptedQuoteHash: form.acceptedQuoteHash,
		giftCardCode: form.giftCardCode,
		...(form.redeemPoints && form.redeemPoints > 0 ? { redeemPoints: form.redeemPoints } : {}),
		cartToken: snapshot.token,
		expectedRevision: snapshot.revision,
		...(attribution ? { attribution } : {}),
		...(tracking ? { tracking } : {}),
	};

	try {
		const { data } = await sellright().POST('/v1/shop/checkout', {
			body,
			params: { header: idempotency(attemptKey()) },
		});
		resetAttemptKey();
		return data as CheckoutResponse;
	} catch (error) {
		if (error instanceof SellRightError && error.status === 409) {
			if (error.code === 'QUOTE_CHANGED') {
				const changed = error.body as { quote?: CheckoutQuote; quoteHash?: string } | undefined;
				if (!changed?.quote || !changed.quoteHash) throw Object.assign(new Error('Updated quote could not be read. Refresh your cart before trying again.'), { cause: error });
				if (snapshot.quote) scope.adoptConflict({ ...snapshot.quote, ...changed.quote, quoteHash: changed.quoteHash }, snapshot.token);
				resetAttemptKey();
				throw new QuoteChangedError(changed.quote, changed.quoteHash);
			}
			const conflict = error.body as CheckoutConflictBody | undefined;
			if (isCartConflict(conflict)) {
				if (conflict.code === 'stale' || conflict.code === 'revision_required') {
					scope.adoptConflict(conflict.cart, snapshot.token);
					throw Object.assign(new Error('Your cart changed — please review it and try again.'), { cause: error });
				}
				if (conflict.code === 'converted') {
					// Keep the token: it is the way back to the unpaid order. The snapshot is adopted (same token) so the
					// mirror shows `converted` and the page resumes instead of retrying.
					scope.adoptConflict(conflict.cart, snapshot.token);
					throw Object.assign(new ConvertedCartError(error.message || undefined), { cause: error });
				}
				// merged: the cart itself is unusable — retire exactly the token that was submitted.
				scope.retire(snapshot.token);
				throw Object.assign(new Error(error.message || 'This cart can no longer be checked out.'), { cause: error });
			}
			if (conflict?.reason === 'payload_mismatch') {
				// The attempt mutated under a used key — rotate so the NEXT try is a
				// fresh idempotency identity (this attempt's error still propagates).
				resetAttemptKey();
			}
			throw Object.assign(new Error(error.message || 'Checkout failed. Please try again.'), { cause: error });
		}
		throw error;
	}
};

/** Mint (or reuse) the order's Stripe PaymentIntent → client_secret. Only
 *  called when POST /checkout leaves the order PendingPayment with a
 *  non-zero total. */
export const createPaymentIntent = async (code: string, receiptToken?: string, expectedAmount?: number): Promise<PaymentIntentResponse> => {
	// The API requires order ownership: the receipt token from POST /checkout
	// (or the signed-in owner's session cookie). `expectedAmount` (express checkout) is the total the wallet sheet
	// showed: the API mints nothing (409 AMOUNT_MISMATCH) when the amount due differs — it never charges this value.
	const header = {
		...(receiptToken ? { 'x-receipt-token': receiptToken } : {}),
		...(expectedAmount !== undefined ? { 'x-expected-amount': String(expectedAmount) } : {}),
	};
	const { data } = await sellright().POST('/v1/shop/orders/{code}/payment-intent', {
		params: { path: { code }, header },
	});
	return nonEmpty(data, 'payment-intent') as PaymentIntentResponse;
};

/**
 * Start a gateway (NMI/Sezzle) payment attempt for a PendingPayment order.
 * NMI: `token` is the Collect.js `payment_token` (never a raw card field) —
 * the API charges synchronously and the returned `status`/`state` reflect
 * the immediate result. Sezzle: no `token` — the response carries
 * `checkoutUrl`, which the caller redirects the browser to; the shopper
 * returns to `/checkout/confirmation/{code}` with a `paymentAttempt` query
 * param (see `verifyGatewayPayment` below).
 *
 * One idempotency key per attempt — a caller retrying the SAME attempt
 * (e.g. a flaky network) must reuse the same key so the API replays the
 * existing attempt instead of starting a second one against the gateway.
 */
export const startGatewayPayment = async (
	code: string,
	method: 'nmi' | 'sezzle',
	opts: { token?: string; card?: { brand: string; last4: string }; idempotencyKey: string; receiptToken?: string },
): Promise<GatewayAttempt> => {
	const { data } = await sellright().POST('/v1/shop/orders/{code}/gateway-payment', {
		params: {
			path: { code },
			header: { ...idempotency(opts.idempotencyKey), ...(opts.receiptToken ? { 'x-receipt-token': opts.receiptToken } : {}) },
		},
		body: { method, ...(opts.token ? { token: opts.token } : {}), ...(opts.card ? { card: opts.card } : {}) },
	});
	return nonEmpty(data, 'gateway-payment') as GatewayAttempt;
};

/**
 * Reconcile a gateway payment attempt with the provider — called right after
 * an NMI charge to confirm its final status, and on the shopper's return
 * from Sezzle's hosted checkout (the `paymentAttempt` query param on the
 * confirmation route names the attempt to verify).
 */
export const verifyGatewayPayment = async (
	code: string,
	attemptId: string,
	receiptToken?: string,
	signal?: AbortSignal,
): Promise<GatewayVerifyResult> => {
	const { data } = await sellright().POST('/v1/shop/orders/{code}/gateway-payment/{attempt}/verify', {
		params: {
			path: { code, attempt: attemptId },
			header: receiptToken ? { 'x-receipt-token': receiptToken } : {},
		},
		signal,
	});
	return nonEmpty(data, 'gateway-payment verify') as GatewayVerifyResult;
};

/**
 * Finalize a zero-due order (grandTotal === 0 — e.g. fully covered by a gift
 * card or loyalty points). POST /checkout already returns state 'Paid' in
 * the normal case; this is the fallback settle for the rare case it is still
 * PendingPayment at zero due. There is no customer-facing "manual"/COD
 * tender — the only payment method this API exposes is Stripe.
 */
export const settleZeroDueOrder = async (code: string, receiptToken?: string): Promise<PayResponse | null> => {
	try {
		const { data } = await sellright().POST('/v1/shop/orders/{code}/pay', {
			params: { path: { code }, header: receiptToken ? { 'x-receipt-token': receiptToken } : {} },
			body: { method: 'stripe' },
		});
		// An empty body is not "settled": the caller falls back to reading the order.
		return nonEmpty(data, 'pay') as PayResponse;
	} catch (error) {
		// 400 'Already covered' — the server settled it first; nothing to do.
		if (error instanceof SellRightError && error.status === 400) return null;
		throw error;
	}
};

/** Read the order's current state for confirmation / error-recovery reads.
 *  Receipt-token scoped (`rt`, from `placeOrder`) OR the authed owner — a
 *  bare code with neither is denied by the API. */
export const getOrder = async (code: string, receiptToken?: string, signal?: AbortSignal): Promise<OrderSummary> => {
	const { data } = await sellright().GET('/v1/shop/orders/{code}', {
		params: { path: { code }, query: receiptToken ? { rt: receiptToken } : {} },
		signal,
	});
	return nonEmpty(data, 'order') as OrderSummary;
};

const fetchShopConfig = async (): Promise<ShopConfig> => {
	const { data } = await sellright().GET('/v1/shop/config', {});
	return nonEmpty(data, 'shop config') as ShopConfig;
};

// One config read per page in the browser (#362): the PDP pay-later line, express buttons, cart drawer, checkout and
// loyalty widgets each asked for it on their own. Public store settings only (no stock, prices or customer data). The
// share is keyed to the page (path + query), so a client-side navigation reads it again, and a failed read is not kept.
// Object-property holder (not a module-level `let`) so the minifier can't fold it. Never used on the server, where a
// module value would outlive the request.
const configShare: { page?: string; read?: Promise<ShopConfig> } = {};

/** Public runtime config — decides whether Stripe is wired for this store. */
export const getShopConfig = (): Promise<ShopConfig> => {
	if (typeof window === 'undefined') return fetchShopConfig();
	const page = window.location.pathname + window.location.search;
	if (configShare.read && configShare.page === page) return configShare.read;
	const read = fetchShopConfig();
	configShare.page = page;
	configShare.read = read;
	read.catch(() => { if (configShare.read === read) configShare.read = undefined; });
	return read;
};

/**
 * Shipping methods for this cart and destination, quoted by the server from the cart's own items and coupons
 * (`POST /v1/shop/shipping-methods`): the API prices the items, applies coupons and tax, and decides eligibility and rate from
 * the store's configured methods. The storefront sends no subtotals and holds no rates, thresholds or fallbacks. An empty
 * cart or a missing country has no quote. Used by both the cart drawer and checkout.
 */
export interface ShippingQuote {
	methods: ShopShippingMethod[];
	/** The nearest free-shipping tier the server reports, or null (already free, none reachable, or an older API). */
	freeShipping: { threshold: number; remaining: number } | null;
}

export const getShippingQuote = async (
	countryCode: string,
	items: readonly { sku: string; quantity: number }[],
	couponCodes: readonly string[] = [],
): Promise<ShippingQuote> => {
	const lines = items.filter((i) => i.sku && i.quantity > 0).map((i) => ({ sku: i.sku, quantity: i.quantity }));
	if (!countryCode || lines.length === 0) return { methods: [], freeShipping: null };
	const { data } = await sellright().POST('/v1/shop/shipping-methods', {
		body: { country: countryCode.toUpperCase(), items: lines, ...(couponCodes.length ? { couponCodes: [...couponCodes] } : {}) },
	});
	const quote = nonEmpty(data, 'shipping-methods');
	return { methods: quote.methods as unknown as ShopShippingMethod[], freeShipping: quote.freeShipping ?? null };
};

/** The methods alone (see `getShippingQuote`). */
export const getEligibleShippingMethods = async (
	countryCode: string,
	items: readonly { sku: string; quantity: number }[],
	couponCodes: readonly string[] = [],
): Promise<ShopShippingMethod[]> => (await getShippingQuote(countryCode, items, couponCodes)).methods;

/**
 * Express checkout (Apple Pay / Google Pay): the server-priced total for the destination country a wallet reports,
 * before the order exists (`POST /v1/shop/cart/{token}/express-quote`). The API reads the cart's own lines, live stock,
 * the eligible shipping methods and destination tax; `cart.grandTotal` is what the wallet shows and `cart.quoteHash`
 * is the consent the order POST re-verifies. A 409 (out of stock, no shipping to that country) throws.
 */
export const getExpressQuote = async (token: string, body: ExpressQuoteRequest): Promise<ExpressQuote> => {
	const { data } = await sellright().POST('/v1/shop/cart/{token}/express-quote', { params: { path: { token } }, body });
	return nonEmpty(data, 'express-quote') as ExpressQuote;
};
