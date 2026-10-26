/**
 * #372: the payment controls are mounted as soon as the shopper's details are valid, before any order exists. PAY asks
 * the page for the order to charge (`ensureOrder$`): the page creates it on the first PAY, or returns the order it already
 * has. `null` means stop without charging: the order could not be created (the page shows why) or its server total
 * differs from the one shown and the shopper has not confirmed it yet.
 */
export interface PayableOrder {
	code: string;
	receiptToken: string;
	/** Stripe only: the PaymentIntent client secret minted for the order ('' for NMI and Sezzle). */
	clientSecret: string;
	/** Where Stripe redirects after confirmation. */
	returnUrl: string;
}

export const confirmationUrl = (origin: string, code: string, receiptToken: string): string =>
	`${origin}/checkout/confirmation/${encodeURIComponent(code)}${receiptToken ? `?rt=${encodeURIComponent(receiptToken)}` : ''}`;
