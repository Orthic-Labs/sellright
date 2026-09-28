/**
 * Native SellRight checkout — the ONE checkout backend for this storefront.
 * There is no Vendure GraphQL fallback and no "convert the local cart to an
 * order" step: the server-cart token (when one exists) IS the order's source
 * of truth, and POST /v1/shop/checkout creates the order directly from it.
 *
 * Every call here goes through `sellright()` (src/sellright/client.ts) —
 * openapi-fetch typed against the API's own OpenAPI document — never the
 * legacy hand-rolled `sr()` helper and never a Vendure shape.
 */
import { sellright, idempotency, SellRightError } from '~/sellright/client';
import { ServerCartService } from '~/services/ServerCartService';
import type {
	CheckoutRequest,
	CheckoutResponse,
	CheckoutConflictBody,
	PayResponse,
	PaymentIntentResponse,
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
	const cart = await ServerCartService.checkoutSnapshot();
	if (cart?.status === 'merged') {
		// This token's lines already moved into the customer's cart at login —
		// falling back to the client item list here would double-submit them.
		ServerCartService.discardLocal();
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
					ServerCartService.adoptConflictCart(conflict.cart);
					throw Object.assign(new Error('Your cart changed — please review it and try again.'), { cause: error });
				}
				// converted / merged: the server already replays the original order
				// for a converted cart before this branch, so reaching it means the
				// cart itself is unusable — retire the token + mirror.
				ServerCartService.discardLocal();
				throw Object.assign(new Error(conflict.error || 'This cart can no longer be checked out.'), { cause: error });
			}
			if (conflict?.reason === 'payload_mismatch') {
				// The attempt mutated under a used key — rotate so the NEXT try is a
				// fresh idempotency identity (this attempt's error still propagates).
				resetAttemptKey();
			}
			throw Object.assign(new Error(conflict?.error || 'Checkout failed. Please try again.'), { cause: error });
		}
		throw error;
	}
};

/** Mint (or reuse) the order's Stripe PaymentIntent → client_secret. Only
 *  called when POST /checkout leaves the order PendingPayment with a
 *  non-zero total. */
export const createPaymentIntent = async (code: string): Promise<PaymentIntentResponse> => {
	const { data } = await sellright().POST('/v1/shop/orders/{code}/payment-intent', {
		params: { path: { code } },
	});
	return data as PaymentIntentResponse;
};

/**
 * Finalize a zero-due order (grandTotal === 0 — e.g. fully covered by a gift
 * card or loyalty points). POST /checkout already returns state 'Paid' in
 * the normal case; this is the fallback settle for the rare case it is still
 * PendingPayment at zero due. There is no customer-facing "manual"/COD
 * tender — the only payment method this API exposes is Stripe.
 */
export const settleZeroDueOrder = async (code: string): Promise<PayResponse | null> => {
	try {
		const { data } = await sellright().POST('/v1/shop/orders/{code}/pay', {
			params: { path: { code } },
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

/** Server-priced shipping methods eligible for this destination + subtotal. */
export const getEligibleShippingMethods = async (
	countryCode: string,
	subtotal: number,
): Promise<ShopShippingMethod[]> => {
	const { data } = await sellright().GET('/v1/shop/shipping-methods', {
		params: { query: { country: countryCode, subtotal } },
	});
	return (data?.methods ?? []) as unknown as ShopShippingMethod[];
};

// ── Back-compat shims ────────────────────────────────────────────────────
// `components/auto-shipping-selector/AutoShippingSelector.tsx` (unused —
// dead legacy Vendure-order code, out of this area's ownership) still
// imports this name; kept so it stays type-safe rather than deleting a file
// this task doesn't own. Backed by the same native call as above.
export const getEligibleShippingMethodsCached = async (countryCode: string, subtotal: number) => {
	const methods = await getEligibleShippingMethods(countryCode, subtotal);
	return methods.map((m) => ({ id: m.code, code: m.code, name: m.name, price: m.rate, priceWithTax: m.rate }));
};
