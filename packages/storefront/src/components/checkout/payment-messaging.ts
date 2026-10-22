// Pay-over-time messaging at the top of checkout (pure decision; CheckoutPaymentMessaging.tsx mounts it).
//
// It is the card gateway's own messaging element, fed the amount the shopper will be charged. Which installment
// methods it names (Affirm, Klarna, Afterpay) is decided by the gateway account's enabled payment methods, the same
// set its payment form offers at the payment step, so the page never advertises a method checkout cannot take. A store
// without that gateway, an unsupported currency, or a zero total shows nothing.

/** Currencies the messaging element accepts (its published option type). */
export const MESSAGING_CURRENCIES = ['AUD', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'NOK', 'NZD', 'PLN', 'SEK', 'USD'] as const;
export type MessagingCurrency = typeof MESSAGING_CURRENCIES[number];

export interface PaymentMessagingInputs {
	gatewayConfigured: boolean | null | undefined;
	publishableKey: string | null | undefined;
	amountCents: number | null | undefined;
	currency: string | null | undefined;
}

export interface PaymentMessagingOptions {
	publishableKey: string;
	amount: number;
	currency: MessagingCurrency;
}

export function paymentMessagingOptions(inputs: PaymentMessagingInputs): PaymentMessagingOptions | null {
	if (!inputs.gatewayConfigured || !inputs.publishableKey) return null;
	const amount = inputs.amountCents ?? 0;
	if (!Number.isSafeInteger(amount) || amount <= 0) return null;
	const currency = (inputs.currency ?? '').toUpperCase();
	if (!(MESSAGING_CURRENCIES as readonly string[]).includes(currency)) return null;
	return { publishableKey: inputs.publishableKey, amount, currency: currency as MessagingCurrency };
}
