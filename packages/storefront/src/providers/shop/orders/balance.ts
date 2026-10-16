/**
 * Stripe settle for an order balance (/orders/{code}?rt=...&pay=balance).
 * The browser never sends an amount: the API mints the PaymentIntent for
 * exactly what is owed and re-verifies it with Stripe when settling.
 */
import { sellright, idempotency } from '~/sellright/client';

/** Settle a confirmed Stripe PaymentIntent against the order's balance. Safe to
 *  repeat: the key is per intent, so a replay is a no-op (the webhook is the backstop). */
export const settleStripeBalance = async (code: string, receiptToken: string, intentId: string): Promise<{ state: string; payment: string }> => {
	const { data } = await sellright().POST('/v1/shop/orders/{code}/pay', {
		params: { path: { code }, header: { 'x-receipt-token': receiptToken, ...idempotency(`balance:${intentId}`) } },
		body: { method: 'stripe', token: intentId },
	});
	return data as { state: string; payment: string };
};
