import { CartService, type CartLockScope } from '~/services/CartService';

/** Thrown when the live pre-submit read shows a cart line that is no longer available. */
export class PreSubmitStockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PreSubmitStockError';
	}
}

/** The validated live read, handed to order creation as the ONLY source of the cart token and revision. */
export interface CheckoutSnapshot {
	token: string;
	revision: number;
	status: string;
}

/**
 * LOCKED (CLAUDE.md layer 4): a fresh, awaited live cart read immediately before the order is created. Unlike the
 * drawer/entry refreshes, a failure here must propagate and stop checkout — it never falls through to submit.
 * No cache, TTL or debounce; every call hits the backend.
 *
 * The response validated here IS the submission snapshot: its token, revision and status are returned and the order
 * POST uses exactly those, so no second read can supply an unchecked revision, and a failed second read cannot drop
 * the cart token. A snapshot is single-use — it is never stored; a revision conflict from the server makes the next
 * attempt run this function (and its live read) again.
 *
 * An active cart with no lines is refused: there is nothing to validate and nothing to buy.
 *
 * Recovery exception: when that live read reports the cart already `converted` (checkout reserved the stock, then
 * the response or the payment-intent call was lost), the lines' `available` is computed AFTER that order's own
 * allocation and is false for the last unit. A converted cart creates no new order (`placeOrder` refuses to POST it
 * and the page resumes the original order), so availability (and a non-empty line list) is not a precondition
 * there. The read itself is never skipped; only what an unavailable line means changes, and only when the server
 * says the cart is converted. A missing/other status is a new order and keeps the fail-closed check.
 */
export const refreshStockBeforeSubmit = async (scope?: CartLockScope): Promise<CheckoutSnapshot> => {
	// Validate the exact response of THIS read, never the shared mirror: a newer overlapping read can supersede this
	// one's mirror write, leaving an older in-stock snapshot behind. A missing cookie, 404 or failed read throws.
	// Checkout passes the scope of the lock it already holds (the lock is not re-entrant, so the public read would
	// wait on itself); an independent caller passes none and takes the lock for this one read.
	const fresh = scope ? await scope.readFresh() : await CartService.readFresh();
	const snapshot: CheckoutSnapshot = { token: fresh.token, revision: fresh.revision, status: fresh.status };
	if (fresh.status === 'converted') return snapshot;
	const lines = fresh.lines ?? [];
	if (lines.length === 0) throw new PreSubmitStockError('Your cart is empty. Please add items before placing an order.');
	const errors = lines
		.filter((line) => line.available !== true)
		.map((line) => `${line.name || line.sku}: Out of stock. Please remove from cart.`);
	if (errors.length) throw new PreSubmitStockError(errors[0] || 'Some items are no longer available.');
	return snapshot;
};

/**
 * Synchronous stock verdict over the cart mirror, which is always the last live server response (never cached). The
 * checkout validation task and the pre-submit read share it so the gate and the submission agree: a cart the server
 * reports `converted` is recovering its OWN order (its lines' `available` already excludes that order's allocation), so
 * availability is not a precondition; any other or missing status is a new order and stays fail-closed.
 */
export const validateCheckoutStock = (): { valid: boolean; errors: string[] } => {
	if (CartService.getCart().status === 'converted') return { valid: true, errors: [] };
	return CartService.validateStock();
};
