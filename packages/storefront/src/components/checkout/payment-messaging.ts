// Pay-over-time messaging at the top of checkout (pure decision; CheckoutPaymentMessaging.tsx mounts it).
//
// It is the card gateway's own messaging element, fed the amount the shopper will be charged. Which installment
// methods it names (Affirm, Klarna, Afterpay) is decided by the gateway account's enabled payment methods, the same
// set its payment form offers at the payment step, so the page never advertises a method checkout cannot take. A store
// without that gateway, an unsupported currency, or a zero total shows nothing.

/** Currencies the messaging element accepts (its published option type). */
export const MESSAGING_CURRENCIES = ['AUD', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'NOK', 'NZD', 'PLN', 'SEK', 'USD'] as const;
export type MessagingCurrency = typeof MESSAGING_CURRENCIES[number];
/** #400: countries the messaging element serves (@stripe/stripe-js 10.1.0 PaymentMethodMessaging `countryCode`). Without a
 *  country the element asks Stripe with the visitor's IP country and an unsupported one (e.g. IN) answers 400 on every
 *  config request, so the element is mounted only for these countries and always told which one. */
export const MESSAGING_COUNTRIES = ['AT', 'AU', 'BE', 'CA', 'CH', 'CZ', 'DE', 'DK', 'ES', 'FI', 'FR', 'GB', 'GR', 'IE', 'IT', 'NL', 'NO', 'NZ', 'PL', 'PT', 'RO', 'SE', 'US'] as const;
export type MessagingCountry = typeof MESSAGING_COUNTRIES[number];

export interface PaymentMessagingInputs {
	gatewayConfigured: boolean | null | undefined;
	publishableKey: string | null | undefined;
	amountCents: number | null | undefined;
	currency: string | null | undefined;
	/** The shopper's country: checkout's shipping country, else the visitor's (geo) country. Unknown or unsupported = none. */
	countryCode: string | null | undefined;
}

export interface PaymentMessagingOptions {
	publishableKey: string;
	amount: number;
	currency: MessagingCurrency;
	countryCode: MessagingCountry;
}

export function paymentMessagingOptions(inputs: PaymentMessagingInputs): PaymentMessagingOptions | null {
	if (!inputs.gatewayConfigured || !inputs.publishableKey) return null;
	const amount = inputs.amountCents ?? 0;
	if (!Number.isSafeInteger(amount) || amount <= 0) return null;
	const currency = (inputs.currency ?? '').toUpperCase();
	if (!(MESSAGING_CURRENCIES as readonly string[]).includes(currency)) return null;
	const countryCode = (inputs.countryCode ?? '').trim().toUpperCase();
	if (!(MESSAGING_COUNTRIES as readonly string[]).includes(countryCode)) return null;
	return { publishableKey: inputs.publishableKey, amount, currency: currency as MessagingCurrency, countryCode: countryCode as MessagingCountry };
}
