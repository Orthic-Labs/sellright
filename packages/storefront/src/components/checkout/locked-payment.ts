// #404: the locked payment box shown before the checkout details are valid (pure decisions; LockedPaymentBox.tsx renders them).
import type { PaymentMethod } from '~/hooks/useCheckout';
import { INSTALLMENT_PROVIDER } from '~/platform/payments/labels';

/** A payment mark the locked box shows: what the store's configured providers accept, never a hard-coded brand list. */
export type PaymentMark = 'cards' | 'apple-pay' | 'link' | typeof INSTALLMENT_PROVIDER;

/** Marks per configured provider: the card gateway (Stripe) takes cards plus its wallets (Apple Pay, Link); the NMI form takes
 *  cards; the installment provider shows its own mark. Ordered cards, wallets, installments; each mark once. */
export function lockedPaymentMarks(methods: readonly PaymentMethod[]): PaymentMark[] {
	const out: PaymentMark[] = [];
	const add = (m: PaymentMark) => { if (!out.includes(m)) out.push(m); };
	if (methods.includes('stripe') || methods.includes('nmi')) add('cards');
	if (methods.includes('stripe')) { add('apple-pay'); add('link'); }
	if (methods.includes(INSTALLMENT_PROVIDER)) add(INSTALLMENT_PROVIDER);
	return out;
}

export const LOCKED_PAYMENT_HEADING = 'Payment';
export const LOCKED_PAYMENT_LINE = 'Enter your email and shipping address to unlock payment.';
export const PAYMENT_UNLOCKED_ANNOUNCEMENT = 'Payment options unlocked.';
