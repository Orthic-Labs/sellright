import type { Stripe, StripeElements } from '@stripe/stripe-js';

export interface CheckoutPaymentRuntime { stripe: Stripe; elements: StripeElements }

/** Confirms the Payment Element, then settles the order; a webhook that settled first (409 with state Paid) counts as paid. */
export async function confirmCheckoutPayment(
	runtime: CheckoutPaymentRuntime,
	returnUrl: string,
	settle: (intentId: string) => Promise<{ state: string }>,
): Promise<void> {
	const result = await runtime.stripe.confirmPayment({
		elements: runtime.elements, confirmParams: { return_url: returnUrl }, redirect: 'if_required',
	});
	if (result.error) throw new Error(result.error.message || 'Payment failed. Please check your payment details.');
	if (result.paymentIntent?.status !== 'succeeded') {
		throw new Error('Payment is not yet complete. Please wait for confirmation before trying again.');
	}
	try {
		const paid = await settle(result.paymentIntent.id);
		if (paid.state !== 'Paid') throw new Error('The order is not yet marked paid.');
	} catch (error) {
		const response = error as { status?: number; body?: string };
		if (response.status === 409) {
			try { if (JSON.parse(response.body ?? '{}').state === 'Paid') return; } catch { /* not a paid response */ }
		}
		// eslint-disable-next-line preserve-caught-error -- the shopper-facing message replaces the transport error on purpose (the tsconfig lib has no ErrorOptions)
		throw new Error('Payment was received, but order confirmation is pending. Do not pay again; contact support with your order number.');
	}
}
