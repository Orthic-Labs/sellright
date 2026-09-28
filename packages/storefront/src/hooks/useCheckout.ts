import { $, useStore } from '@qwik.dev/core';
import {
	placeOrder as srPlaceOrder,
	createPaymentIntent as srCreatePI,
	settleZeroDueOrder as srSettleZeroDue,
	type CheckoutForm,
} from '~/providers/shop/checkout/checkout';
import { decideCheckoutStage } from './checkout-stage';

/**
 * Native checkout flow — single state machine, single backend. There is no
 * flag and no legacy fallback: every checkout on this storefront goes
 * through POST /v1/shop/checkout.
 *
 *   idle → placing (POST /checkout) → either
 *     - paid    (grandTotal 0, or the server already settled it — e.g. a
 *                gift card / loyalty points covered the whole total), or
 *     - paying  (PaymentIntent client_secret → Stripe Payment Element mounts)
 *   → confirming (Stripe redirect to /checkout/confirmation/{code}?rt=…)
 *   any step → error (recoverable — the order stays PendingPayment for retry)
 */
export type CheckoutPhase = 'idle' | 'placing' | 'paid' | 'paying' | 'error';

export const useCheckout = () => {
	const checkoutState = useStore({
		isLoading: false,
		error: null as string | null,
	});

	const state = useStore({
		phase: 'idle' as CheckoutPhase,
		code: '' as string,
		receiptToken: '' as string,
		clientSecret: '' as string,
		grandTotal: 0,
		error: null as string | null,
	});

	/**
	 * Create the order, then resolve either the zero-due short-circuit OR a
	 * Stripe PaymentIntent. Returns the resulting phase so the caller can mount
	 * the Payment Element ('paying') or navigate straight to confirmation
	 * ('paid').
	 */
	const placeOrder = $(async (form: CheckoutForm): Promise<CheckoutPhase> => {
		state.phase = 'placing';
		state.error = null;
		checkoutState.isLoading = true;
		try {
			const created = await srPlaceOrder(form);
			state.code = created.code;
			state.receiptToken = created.receiptToken ?? '';
			state.grandTotal = created.grandTotal;
			state.clientSecret = '';

			const outcome = decideCheckoutStage(created);
			if (outcome.kind === 'paid') {
				if (outcome.needsSettle) {
					try {
						await srSettleZeroDue(created.code);
					} catch {
						/* server may have already settled it independently */
					}
				}
				state.phase = 'paid';
				return 'paid';
			}

			// Card path — mint the PaymentIntent and hand the client_secret to the
			// Stripe Payment Element (mounted by the caller).
			const pi = await srCreatePI(created.code);
			if (!pi.clientSecret) throw new Error('Could not start the payment.');
			state.clientSecret = pi.clientSecret;
			state.phase = 'paying';
			return 'paying';
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Checkout failed. Please try again.';
			state.error = msg;
			checkoutState.error = msg;
			state.phase = 'error';
			return 'error';
		} finally {
			checkoutState.isLoading = false;
		}
	});

	return {
		checkoutState,
		state,
		placeOrder,
	};
};
