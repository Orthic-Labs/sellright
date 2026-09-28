import type { CheckoutResponse } from '~/sellright/types/checkout';

export type CheckoutStageOutcome =
	/** Zero-due order — nothing further to collect from the shopper. `needsSettle`
	 *  is true when the server hasn't already flipped the order to Paid itself
	 *  (rare: e.g. a gift card covered the total but settlement lags a beat). */
	| { kind: 'paid'; needsSettle: boolean }
	/** Non-zero total, still PendingPayment — the caller must mint a Stripe
	 *  PaymentIntent and mount the Payment Element. */
	| { kind: 'card-required' };

/**
 * Pure stage-gating decision for what happens immediately after POST
 * /v1/shop/checkout returns. Split out of `useCheckout` so it's unit
 * testable without a Qwik render context (`useStore`/`$` require one).
 *
 * Order of checks matters: `state === 'Paid'` is checked first because a
 * gift-card/loyalty-covered order can be exactly zero-due AND already Paid
 * in the same response — in that case there is nothing left to settle.
 */
export const decideCheckoutStage = (
	created: Pick<CheckoutResponse, 'state' | 'grandTotal'>,
): CheckoutStageOutcome => {
	if (created.state === 'Paid') return { kind: 'paid', needsSettle: false };
	if (created.grandTotal === 0) return { kind: 'paid', needsSettle: true };
	return { kind: 'card-required' };
};
