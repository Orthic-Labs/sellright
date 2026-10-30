// V27: when the checkout page makes its checkout-intent pricing read (pure decision; routes/checkout/index.tsx wires it).

/**
 * What a change of the pricing inputs (addresses, shipping method, points) does:
 *  - `same`: the inputs equal the last recorded read's — nothing (an equal object replaced, a re-run with no change);
 *  - `wait`: the inputs changed while a shipping quote for new inputs is in flight — reset consent and the quote
 *    context now, but defer the read: the quote is about to select the method, and a read without it would be replaced
 *    by the method's own read a moment later. The inputs are NOT recorded, so the read happens once the quote settles;
 *  - `read`: record the inputs and make the one live pricing read for this change.
 * Every change still ends in a live read; nothing here caches or skips a required check.
 */
export type PricingReadStep = 'same' | 'wait' | 'read';

export const pricingReadStep = (s: { context: string; recorded: string; shippingPending: boolean }): PricingReadStep => {
	if (s.context === s.recorded) return 'same';
	return s.shippingPending ? 'wait' : 'read';
};
