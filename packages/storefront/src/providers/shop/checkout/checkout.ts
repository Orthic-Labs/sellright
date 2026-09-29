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
import { CartService } from '~/services/CartService';
import type {
	CheckoutRequest,
	CheckoutResponse,
	CheckoutConflictBody,
	PayResponse,
	PaymentIntentResponse,
	GatewayAttempt,
	GatewayVerifyResult,
	OrderSummary,
	ShopConfig,
	ShopShippingMethod,
} from '~/sellright/types/checkout';

export interface CheckoutForm {
	/** Fallback line items when no server-cart token exists yet. */
	items?: { sku: string; quantity: number }[];
	email?: string;
	shippingAddress?: Record<string, unknown>;
	billingAddress?: Record<string, unknown>;
	shippingMethodCode?: string;
	couponCode?: string;
	giftCardCode?: string;
	/** Points to redeem — the server re-validates against the customer's actual balance. */
	redeemPoints?: number;
}

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
 * authoritative — when a cart token is present its lines win and the client
 * item list is only the bootstrap value the schema requires. Conversion is a
 * non-append mutation: `expectedRevision` echoes the cart's live revision
 * (missing → 409 `revision_required`, mismatched → 409 `stale` + the current
 * cart snapshot, which is adopted into the local mirror).
 */
export const placeOrder = async (form: CheckoutForm): Promise<CheckoutResponse> => {
	const cart = await CartService.checkoutSnapshot();
	if (cart?.status === 'merged') {
		// This token's lines already moved into the customer's cart at login —
		// falling back to the client item list here would double-submit them.
		CartService.discard();
		throw new Error('Your cart was merged into your account — please re-add your items.');
	}

	const body: CheckoutRequest = {
		items: form.items && form.items.length ? form.items : [{ sku: '__cart__', quantity: 1 }],
		email: form.email,
		shippingAddress: form.shippingAddress,
		billingAddress: form.billingAddress,
		shippingMethodCode: form.shippingMethodCode,
		couponCode: form.couponCode,
		giftCardCode: form.giftCardCode,
		...(form.redeemPoints && form.redeemPoints > 0 ? { redeemPoints: form.redeemPoints } : {}),
	};
	if (cart) {
		body.cartToken = cart.token;
		body.expectedRevision = cart.revision;
	}

	try {
		const { data } = await sellright().POST('/v1/shop/checkout', {
			body,
			params: { header: idempotency(attemptKey()) },
		});
		resetAttemptKey();
		return data as CheckoutResponse;
	} catch (error) {
		if (error instanceof SellRightError && error.status === 409) {
			const conflict = error.body as CheckoutConflictBody | undefined;
			if (isCartConflict(conflict)) {
				if (conflict.code === 'stale' || conflict.code === 'revision_required') {
					CartService.adoptConflict(conflict.cart);
					throw Object.assign(new Error('Your cart changed — please review it and try again.'), { cause: error });
				}
				// converted / merged: the server already replays the original order
				// for a converted cart before this branch, so reaching it means the
				// cart itself is unusable — retire the token + mirror.
				CartService.discard();
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
export const createPaymentIntent = async (code: string, receiptToken?: string): Promise<PaymentIntentResponse> => {
	// The API requires order ownership: the receipt token from POST /checkout
	// (or the signed-in owner's session cookie).
	const { data } = await sellright().POST('/v1/shop/orders/{code}/payment-intent', {
		params: { path: { code }, header: receiptToken ? { 'x-receipt-token': receiptToken } : {} },
	});
	return data as PaymentIntentResponse;
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
	opts: { token?: string; idempotencyKey: string; receiptToken?: string },
): Promise<GatewayAttempt> => {
	const { data } = await sellright().POST('/v1/shop/orders/{code}/gateway-payment', {
		params: {
			path: { code },
			header: { ...idempotency(opts.idempotencyKey), ...(opts.receiptToken ? { 'x-receipt-token': opts.receiptToken } : {}) },
		},
		body: { method, ...(opts.token ? { token: opts.token } : {}) },
	});
	return data as GatewayAttempt;
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
): Promise<GatewayVerifyResult> => {
	const { data } = await sellright().POST('/v1/shop/orders/{code}/gateway-payment/{attempt}/verify', {
		params: {
			path: { code, attempt: attemptId },
			header: receiptToken ? { 'x-receipt-token': receiptToken } : {},
		},
	});
	return data as GatewayVerifyResult;
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
		return data as PayResponse;
	} catch (error) {
		// 400 'Already covered' — the server settled it first; nothing to do.
		if (error instanceof SellRightError && error.status === 400) return null;
		throw error;
	}
};

/** Read the order's current state for confirmation / error-recovery reads.
 *  Receipt-token scoped (`rt`, from `placeOrder`) OR the authed owner — a
 *  bare code with neither is denied by the API. */
export const getOrder = async (code: string, receiptToken?: string): Promise<OrderSummary> => {
	const { data } = await sellright().GET('/v1/shop/orders/{code}', {
		params: { path: { code }, query: receiptToken ? { rt: receiptToken } : {} },
	});
	return data as OrderSummary;
};

/** Public runtime config — decides whether Stripe is wired for this store. */
export const getShopConfig = async (): Promise<ShopConfig> => {
	const { data } = await sellright().GET('/v1/shop/config', {});
	return data as ShopConfig;
};

/**
 * Server-priced shipping methods eligible for this destination + subtotal.
 * `discountedSubtotalWithTax` (post-coupon subtotal) is passed alongside the
 * raw `subtotal` so a threshold rule keyed on the discounted basis (e.g. a
 * coupon-driven free-shipping tier) is decided server-side — never guessed
 * client-side by zeroing the rate ourselves.
 */
export const getEligibleShippingMethods = async (
	countryCode: string,
	subtotal: number,
	discountedSubtotalWithTax?: number,
): Promise<ShopShippingMethod[]> => {
	const { data } = await sellright().GET('/v1/shop/shipping-methods', {
		params: { query: { country: countryCode, subtotal, discountedSubtotalWithTax } },
	});
	return (data?.methods ?? []) as unknown as ShopShippingMethod[];
};
