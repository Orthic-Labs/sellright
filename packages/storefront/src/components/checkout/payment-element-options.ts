// Payment Element options shared by every mount (checkout payment panel, checkout resume panel, orders/[code], license
// checkout). A plain module so unit tests can import it (Qwik component files cannot be).
//
// An open accordion with radios, in a fixed order: card first, then the pay-later methods, then Cash App, Link and
// crypto last. Methods the gateway account has not enabled (or that do not apply to the amount, currency or country) are
// skipped by Stripe, never shown. Apple Pay and Google Pay are not offered here: they are buttons in the express row.
import type { StripePaymentElementOptions } from '@stripe/stripe-js';

export const PAYMENT_METHOD_ORDER = ['card', 'affirm', 'klarna', 'afterpay_clearpay', 'cashapp', 'link', 'crypto'] as const;

export function paymentElementOptions(): StripePaymentElementOptions {
	return {
		layout: { type: 'accordion', defaultCollapsed: false, radios: 'always', spacedAccordionItems: false },
		wallets: { applePay: 'never', googlePay: 'never' },
		paymentMethodOrder: [...PAYMENT_METHOD_ORDER],
	};
}
