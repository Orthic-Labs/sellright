import { CartService } from '~/services/CartService';

/** Thrown when the live pre-submit read shows a cart line that is no longer available. */
export class PreSubmitStockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PreSubmitStockError';
	}
}

/**
 * LOCKED (CLAUDE.md layer 4): a fresh, awaited live cart read immediately before the order is created. Unlike the
 * drawer/entry refreshes, a failure here must propagate and stop checkout — it never falls through to submit.
 * No cache, TTL or debounce; every call hits the backend.
 *
 * Recovery exception: when that live read reports the cart already `converted` (checkout reserved the stock, then
 * the response or the payment-intent call was lost), the lines' `available` is computed AFTER that order's own
 * allocation and is false for the last unit. POST /checkout replays the original order for a converted cart without
 * touching stock, so availability is not a precondition there. The read itself is never skipped; only what an
 * unavailable line means changes, and only when the server says the cart is converted. A missing/other status is a
 * new order and keeps the fail-closed check.
 */
export const refreshStockBeforeSubmit = async (): Promise<void> => {
	await CartService.refresh();
	const check = validateCheckoutStock();
	if (!check.valid) throw new PreSubmitStockError(check.errors[0] || 'Some items are no longer available.');
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
