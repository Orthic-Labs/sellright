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
 *     - paying  (non-zero total, still PendingPayment) — the caller mounts
 *                whichever payment method the shopper picked:
 *                'stripe' -> PaymentIntent client_secret + Payment Element
 *                'nmi'/'sezzle' -> no client_secret; the NMI/Sezzle
 *                components call the gateway-payment API directly
 *   → confirming (redirect to /checkout/confirmation/{code}?rt=… — Stripe's
 *     own redirect, or the NMI/Sezzle component navigating there itself)
 *   any step → error (recoverable — the order stays PendingPayment for retry)
 */
export type CheckoutPhase = 'idle' | 'placing' | 'paid' | 'paying' | 'error';
export type PaymentMethod = 'stripe' | 'nmi' | 'sezzle';

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
		method: null as PaymentMethod | null,
		error: null as string | null,
	});

	/**
	 * Create the order, then resolve either the zero-due short-circuit OR the
	 * requested payment method. `method` decides what "paying" needs from the
	 * caller: a Stripe PaymentIntent (minted here) or nothing at all (NMI/
	 * Sezzle components own their own API calls). Returns the resulting phase
	 * so the caller can mount the right payment UI ('paying') or navigate
	 * straight to confirmation ('paid').
	 */
	const placeOrder = $(async (form: CheckoutForm, method: PaymentMethod = 'stripe'): Promise<CheckoutPhase> => {
		state.phase = 'placing';
		state.error = null;
		checkoutState.isLoading = true;
		try {
			const created = await srPlaceOrder(form);
			state.code = created.code;
			state.receiptToken = created.receiptToken ?? '';
			state.grandTotal = created.grandTotal;
			state.clientSecret = '';
			state.method = method;

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

			if (method === 'stripe') {
				// Card path — mint the PaymentIntent and hand the client_secret to
				// the Stripe Payment Element (mounted by the caller).
				const pi = await srCreatePI(created.code);
				if (!pi.clientSecret) throw new Error('Could not start the payment.');
				state.clientSecret = pi.clientSecret;
			}
			// nmi/sezzle: nothing to mint up front — the NMI/Sezzle component
			// calls startGatewayPayment itself once mounted.
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
