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
import { ConvertedCartError, type CartLockScope } from '~/services/CartService';
import type { CheckoutSnapshot } from '~/hooks/pre-submit-stock';
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
	/** Bootstrap line items the request schema requires; the server cart's lines win. */
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

	const body: CheckoutRequest = {
		items: form.items && form.items.length ? form.items : [{ sku: '__cart__', quantity: 1 }],
		email: form.email,
		shippingAddress: form.shippingAddress,
		billingAddress: form.billingAddress,
		shippingMethodCode: form.shippingMethodCode,
		couponCode: form.couponCode,
		giftCardCode: form.giftCardCode,
		...(form.redeemPoints && form.redeemPoints > 0 ? { redeemPoints: form.redeemPoints } : {}),
		cartToken: snapshot.token,
		expectedRevision: snapshot.revision,
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
export const createPaymentIntent = async (code: string, receiptToken?: string): Promise<PaymentIntentResponse> => {
	// The API requires order ownership: the receipt token from POST /checkout
	// (or the signed-in owner's session cookie).
	const { data } = await sellright().POST('/v1/shop/orders/{code}/payment-intent', {
		params: { path: { code }, header: receiptToken ? { 'x-receipt-token': receiptToken } : {} },
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
	opts: { token?: string; idempotencyKey: string; receiptToken?: string },
): Promise<GatewayAttempt> => {
	const { data } = await sellright().POST('/v1/shop/orders/{code}/gateway-payment', {
		params: {
			path: { code },
			header: { ...idempotency(opts.idempotencyKey), ...(opts.receiptToken ? { 'x-receipt-token': opts.receiptToken } : {}) },
		},
		body: { method, ...(opts.token ? { token: opts.token } : {}) },
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

/** Public runtime config — decides whether Stripe is wired for this store. */
export const getShopConfig = async (): Promise<ShopConfig> => {
	const { data } = await sellright().GET('/v1/shop/config', {});
	return nonEmpty(data, 'shop config') as ShopConfig;
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
	return (nonEmpty(data, 'shipping-methods').methods ?? []) as unknown as ShopShippingMethod[];
};
