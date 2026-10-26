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

export interface PaymentControlsInput {
	phase: string;
	code: string;
	clientSecret: string;
	chargeTotalCents: number;
}

/**
 * Whether the payment controls are mounted (#372). Before the order exists they show once something is due; they stay
 * mounted through the WHOLE order creation: `placeOrder` sets the order code first and the phase to 'paying' only after
 * an awaited payment initialisation, so a test on `phase === 'paying' || !code` is false in that gap, the controls
 * unmount, and the PAY in flight is abandoned (2026-10-26: DD30345 created, never charged). 'paid' leaves for
 * confirmation; an order that failed after creation ('error' with a code) is recovered by the page.
 */
export const paymentControlsMounted = (s: PaymentControlsInput): boolean =>
	s.phase === 'paying' || s.phase === 'placing' || (!s.code && s.phase !== 'paid' && s.chargeTotalCents > 0);

/** The Stripe element can mount: with the order's intent secret, or deferred (no secret) at any point before 'paying'. */
export const stripeElementMountable = (s: PaymentControlsInput): boolean =>
	!!s.clientSecret || s.phase !== 'paying';
