// Express checkout away from the checkout page: the cart drawer (the shopper's cart) and PDP buy-now (a dedicated
// single-line cart). Both create the order exactly as PLACE ORDER does (express-checkout.ts `runExpressConfirm` calls
// `placeExpressOrder` as its `placeOrder` step):
//   1. a fresh, awaited live read of the cart (stock validated on THAT response, never a cache) — `validate`,
//   2. POST /v1/shop/checkout with that read's token + revision and the wallet quote's hash as consent (a different
//      server total is a 409 QUOTE_CHANGED, refused in the sheet) — `placeOrder`,
//   3. the payment intent minted only for the wallet's exact total (`x-expected-amount`; any difference mints nothing).
// The browser then confirms the wallet payment and lands on /checkout/confirmation/{code}, where purchase fires once.
import { sellright } from '~/sellright/client';
import type { CartLockScope } from '~/services/CartService';
import type { CheckoutSnapshot } from '~/hooks/pre-submit-stock';
import type { ServerCart } from '~/sellright/types/cart';
import type { ExpressOrderForm, ExpressOrderResult } from './express-checkout';

export interface ExpressPlacementDeps {
	/** Run `fn` with the cart's scope: the shopper's cart under its cart lock, a buy-now cart with its own detached reads. */
	withCart: <T>(fn: (scope: CartLockScope) => Promise<T>) => Promise<T>;
	/** LOCKED live read immediately before the order (hooks/pre-submit-stock.ts `refreshStockBeforeSubmit`). */
	validate: (scope: CartLockScope) => Promise<CheckoutSnapshot>;
	/** POST /v1/shop/checkout from the validated snapshot (providers/shop/checkout `placeOrder`). */
	placeOrder: (form: ExpressOrderForm, snapshot: CheckoutSnapshot, scope: CartLockScope) => Promise<{ code: string; receiptToken?: string | null; grandTotal: number }>;
	/** POST /v1/shop/orders/{code}/payment-intent with `x-expected-amount`. */
	createPaymentIntent: (code: string, receiptToken: string | undefined, expectedAmount: number) => Promise<{ clientSecret?: string | null }>;
	/** A line was unavailable at the live read or at order creation: re-read the shopper's cart so it shows the real state. */
	onStockConflict?: () => Promise<unknown>;
}

const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const isStockConflict = (error: unknown): boolean => {
	for (const e of [error, (error as { cause?: unknown } | null)?.cause]) {
		if (!e || typeof e !== 'object') continue;
		if ((e as Error).name === 'PreSubmitStockError') return true;
		if ((e as { status?: number }).status === 409 && (e as { code?: string }).code === 'OUT_OF_STOCK') return true;
	}
	return false;
};

/** The wallet's order step: ok only when an order exists whose payment intent was minted for exactly `expectedAmount`. */
export async function placeExpressOrder(deps: ExpressPlacementDeps, form: ExpressOrderForm, expectedAmount: number): Promise<ExpressOrderResult> {
	let created: { code: string; receiptToken?: string | null; grandTotal: number };
	try {
		created = await deps.withCart(async (scope) => deps.placeOrder(form, await deps.validate(scope), scope));
	} catch (error) {
		if ((error as Error | null)?.name === 'ConvertedCartError') {
			return { ok: false, message: 'This cart already has an order waiting for payment. Please continue at checkout.' };
		}
		if (isStockConflict(error)) await deps.onStockConflict?.().catch(() => undefined);
		return { ok: false, message: message(error, 'Checkout failed. Please try again.') };
	}
	// The server total is what is charged; the wallet showed `expectedAmount`. Any difference is refused here (the
	// payment-intent call would refuse it as well): the shopper never pays a total they did not see.
	if (created.grandTotal !== expectedAmount) return { ok: false, message: 'Your total changed. Please review it and try again.' };
	try {
		const pi = await deps.createPaymentIntent(created.code, created.receiptToken || undefined, expectedAmount);
		if (!pi.clientSecret) return { ok: false, message: "We couldn't start your payment. Please try again." };
		return { ok: true, clientSecret: pi.clientSecret, code: created.code, receiptToken: created.receiptToken ?? '' };
	} catch (error) {
		return { ok: false, message: message(error, "We couldn't start your payment. Please try again.") };
	}
}

// ---------------------------------------------------------------------------------------------------- PDP buy-now cart
// Buy-now never touches the shopper's cart: it gets its own server cart holding exactly the selected variant at qty 1.
// That cart's token lives only in the component (never the `sr_cart` cookie), and it is created WITHOUT credentials so
// it belongs to no customer: a login merge (which folds the customer's other active carts into the cookie cart) can
// never pull an abandoned buy-now line into the shopper's cart. Unused buy-now carts expire with the cart TTL.

/** Create the single-line buy-now cart. Throws when the API refuses (unknown sku, rate limit). */
export async function createBuyNowCart(items: { sku: string; quantity: 1 }[]): Promise<string> {
	const { data } = await sellright().POST('/v1/shop/cart', { body: { items }, credentials: 'omit' });
	if (!data?.token) throw new Error('Could not start buy now.');
	return data.token;
}

/** Quote context of the wallet total being confirmed: the live read is priced in it, so its quote hash is comparable. */
export interface BuyNowReadContext { shipCountry: string; shippingMethodCode?: string }

/**
 * The cart scope of a buy-now cart: `readFresh` is a live GET of THAT token (no cookie, no shared mirror), priced in
 * the wallet quote's checkout context. There is no local mirror, so conflict adoption and retirement have nothing to do.
 */
export function detachedCartScope(token: string, ctx: BuyNowReadContext): CartLockScope {
	return {
		async readFresh(): Promise<ServerCart> {
			const { data } = await sellright().GET('/v1/shop/cart/{token}', {
				params: { path: { token }, query: { pricingIntent: 'checkout', shipCountry: ctx.shipCountry, ...(ctx.shippingMethodCode ? { shippingMethodCode: ctx.shippingMethodCode } : {}) } },
			});
			if (!data) throw new Error('Your item could not be verified. Please try again.');
			return data as ServerCart;
		},
		adoptConflict: () => undefined,
		retire: () => undefined,
	};
}
