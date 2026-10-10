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
 */
export const refreshStockBeforeSubmit = async (): Promise<void> => {
	await CartService.refresh();
	const check = CartService.validateStock();
	if (!check.valid) throw new PreSubmitStockError(check.errors[0] || 'Some items are no longer available.');
};
