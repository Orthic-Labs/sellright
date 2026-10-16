import type { CheckoutResponse } from '~/sellright/types/checkout';
import { classifyOrderState } from '~/services/order-state';

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

export type ResumeStageOutcome =
	/** Still PendingPayment with money due — mount the payment controls for the EXISTING order. */
	| { kind: 'payable' }
	/** Still PendingPayment but nothing due — settle it, then confirm. */
	| { kind: 'zero-due' }
	/** Paid (or later) — go to the confirmation page, which retires the cart token. */
	| { kind: 'settled' }
	/** Cancelled — never payable; show the cancelled state and offer a new cart. */
	| { kind: 'cancelled' }
	/** Any other / unknown state — a retryable error; the token is kept. */
	| { kind: 'error' };

/**
 * Pure stage decision for RESUMING the original order of a converted cart. Unlike `decideCheckoutStage` (the
 * response of a brand-new POST, where anything not Paid and not zero-due is card-required), an existing order can be
 * cancelled or in a state this storefront does not know: those must never reach a payment form.
 */
export const decideResumeStage = (state: string | undefined | null, grandTotal: number): ResumeStageOutcome => {
	switch (classifyOrderState(state)) {
		case 'settled':
			return { kind: 'settled' };
		case 'cancelled':
			return { kind: 'cancelled' };
		case 'payable':
			return grandTotal > 0 ? { kind: 'payable' } : { kind: 'zero-due' };
		default:
			return { kind: 'error' };
	}
};

export type CheckoutEntryDecision =
	/** The cart is converted: show its original order, before any gate. */
	| 'resume'
	/** The live cart read failed and the cart is not known to be converted: look the original order up read-only, and
	 *  if there is none stay on a retryable unresolved state. Never the normal checkout, never an inferred empty cart. */
	| 'probe'
	/** The cart was read (or there is genuinely no cart): the normal new-order checkout. */
	| 'normal';

/**
 * Pure decision for checkout ENTRY, taken after the live cart read. A failed read proves nothing about the cart, so it
 * must not select the normal checkout (which would show an empty cart or a new-order form for a cart that may already
 * be an unpaid order).
 */
export const decideCheckoutEntry = (input: { status: string | undefined; readFailed: boolean; hasToken: boolean }): CheckoutEntryDecision => {
	if (input.status === 'converted') return 'resume';
	if (input.readFailed && input.hasToken) return 'probe';
	return 'normal';
};

/**
 * Pure predicate for a conversion discovered AFTER checkout initialisation (a later cart refresh, a cart-drawer
 * action or another tab's order reaching the mirror): the page must switch to the resume view even though the form is
 * incomplete or the cart's lines are gone. It must not fire while the entry sequence or a PLACE ORDER of this tab is
 * running (both resume on their own), nor once this tab holds an order of its own.
 */
export const shouldResumeLate = (input: {
	status: string | undefined;
	resume: string;
	orderCode: string;
	/** Phase of this tab's own order. An order whose payment initialisation failed ('error') is not a working payment view. */
	phase?: string;
	pageLoading: boolean;
	processing: boolean;
}): boolean =>
	input.status === 'converted' &&
	input.resume === 'none' &&
	!(input.orderCode && input.phase !== 'error') &&
	!input.pageLoading &&
	!input.processing;

/**
 * An order this tab created whose PLACE ORDER ended in an error AFTER the order existed (payment initialisation or
 * zero-due settlement failed): the order is real and unpaid, so the page recovers it through the resume view instead
 * of leaving it behind the new-order gates. A converted-cart refusal is excluded (it has its own resume call).
 */
export const shouldRecoverExistingOrder = (input: { phase: string; orderCode: string; convertedCart: boolean }): boolean =>
	input.phase === 'error' && !!input.orderCode && !input.convertedCart;

/**
 * Default payment method for a shop config: stripe > nmi > installments, whichever the store actually has. `null` when
 * the store has no gateway at all.
 */
export const defaultPaymentMethod = (
	cfg: { stripeConfigured?: boolean; gateways?: { nmi?: unknown; sezzle?: unknown } } | null | undefined,
): 'stripe' | 'nmi' | 'sezzle' | null => {
	if (!cfg) return null;
	if (cfg.stripeConfigured) return 'stripe';
	if (cfg.gateways?.nmi) return 'nmi';
	if (cfg.gateways?.sezzle) return 'sezzle';
	return null;
};

/**
 * The shop config's DEFAULT method is applied exactly once. A later completion (the other of two overlapping config
 * requests, a retry) still refreshes the config but must never overwrite what is selected by then: the shopper can
 * only pick a method after the first application, and `clientSecret` belongs to that selection.
 */
export const shouldApplyConfigDefault = (alreadyApplied: boolean): boolean => !alreadyApplied;

/** The order-bound fields of the checkout store that belong to ONE order: every exit from a resume state clears all of them. */
export const EMPTY_ORDER_STATE = {
	phase: 'idle' as const,
	code: '',
	receiptToken: '',
	clientSecret: '',
	grandTotal: 0,
	shownTotal: 0,
	stockConflict: false,
	method: null,
	error: null,
	resume: 'none' as const,
	convertedCart: false,
	resumeLines: [] as { name: string; quantity: number }[],
	paymentError: null,
};
