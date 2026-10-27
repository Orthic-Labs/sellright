// Payment Element options shared by every mount (checkout payment panel, checkout resume panel, orders/[code], license
// checkout). A plain module so unit tests can import it (Qwik component files cannot be).
//
// An open accordion with radios, in a fixed order: card first, then the pay-later methods, then Cash App, Link and
// crypto last. Methods the gateway account has not enabled (or that do not apply to the amount, currency or country) are
// skipped by Stripe, never shown. Apple Pay and Google Pay are not offered here: they are buttons in the express row.
import type { StripePaymentElementOptions } from '@stripe/stripe-js';

export const PAYMENT_METHOD_ORDER = ['card', 'affirm', 'klarna', 'afterpay_clearpay', 'cashapp', 'link', 'crypto'] as const;

/** The address fields the Payment Element's billing defaults are filled from (checkout's AppState address shapes). */
export interface BillingDefaultsSource {
	countryCode?: string | null; postalCode?: string | null; province?: string | null; city?: string | null;
	streetLine1?: string | null; streetLine2?: string | null;
}

/** #400: the Payment Element's billing defaults: the separate billing address when the shopper entered one, else the shipping
 *  address. Without them Stripe falls back to the visitor's geo country (India for a US shipment in the review), so the card's
 *  country/ZIP did not match where the order ships. Undefined when no country is known yet (Stripe's own default stands). */
export function billingDefaultValues(billing: BillingDefaultsSource | null | undefined, shipping: BillingDefaultsSource | null | undefined): StripePaymentElementOptions['defaultValues'] | undefined {
	const src = billing?.countryCode?.trim() ? billing : shipping;
	const country = src?.countryCode?.trim().toUpperCase();
	if (!src || !country || !/^[A-Z]{2}$/.test(country)) return undefined;
	const v = (x: string | null | undefined) => (x && x.trim() ? x.trim() : undefined);
	const address = { country, postal_code: v(src.postalCode), state: v(src.province), city: v(src.city), line1: v(src.streetLine1), line2: v(src.streetLine2) };
	return { billingDetails: { address: Object.fromEntries(Object.entries(address).filter(([, x]) => x !== undefined)) } };
}

export function paymentElementOptions(defaultValues?: StripePaymentElementOptions['defaultValues']): StripePaymentElementOptions {
	return {
		...(defaultValues ? { defaultValues } : {}),
		layout: { type: 'accordion', defaultCollapsed: false, radios: 'always', spacedAccordionItems: false },
		wallets: { applePay: 'never', googlePay: 'never' },
		paymentMethodOrder: [...PAYMENT_METHOD_ORDER],
	};
}
