/**
 * Pure helpers for the order-balance pay page (/orders/{code}?rt=...&pay=balance),
 * the page the "balance due" email opens after an admin order edit raised the
 * total. No network, no Qwik — unit-tested in balance-pay.test.ts.
 */
import type { ShopConfig } from '~/sellright/types/checkout';

export type BalancePageState =
	| 'invalid' // no/unknown receipt token, or order not found
	| 'unavailable' // the order could not be loaded (network/server)
	| 'not-payable' // Cancelled / Refunded / still PendingPayment (use checkout)
	| 'due' // Paid or PartiallyRefunded with a positive balance
	| 'settled' // the balance was just paid on this page
	| 'nothing-due'; // nothing owed (already paid earlier)

export interface BalanceOrderFacts {
	state: string;
	amountDue?: number | null;
}

/** Decide which of the page's states to show. */
export function balancePageState(input: {
	hasToken: boolean;
	order?: BalanceOrderFacts | null;
	errorStatus?: number | null;
	justPaid?: boolean;
}): BalancePageState {
	const { hasToken, order, errorStatus, justPaid } = input;
	if (!hasToken) return 'invalid';
	if (errorStatus === 404 || errorStatus === 401 || errorStatus === 403) return 'invalid';
	if (!order) return 'unavailable';
	if (order.state !== 'Paid' && order.state !== 'PartiallyRefunded') return 'not-payable';
	if ((order.amountDue ?? 0) > 0) return 'due';
	return justPaid ? 'settled' : 'nothing-due';
}

export type BalanceMethod = 'nmi' | 'sezzle';

/**
 * Gateways the shopper can pay a balance with, in display order, from the
 * public store config. Stripe is deliberately absent: the API settles an
 * order balance only through the NMI / Sezzle gateway-payment routes.
 */
export function availableBalanceMethods(config: Pick<ShopConfig, 'gateways'> | null | undefined): BalanceMethod[] {
	const out: BalanceMethod[] = [];
	if (config?.gateways?.nmi?.tokenizationKey) out.push('nmi');
	if (config?.gateways?.sezzle) out.push('sezzle');
	return out;
}

/** Whether the URL asks for the balance flow (`?pay=balance`). */
export function wantsBalancePay(search: URLSearchParams): boolean {
	return search.get('pay') === 'balance';
}

/** The receipt token carried on the pay link, trimmed; undefined when absent. */
export function receiptTokenFrom(search: URLSearchParams): string | undefined {
	const rt = search.get('rt')?.trim();
	return rt ? rt : undefined;
}

/** What the order already carries toward its total, for the "Already paid" row. */
export function alreadyPaidCents(grandTotal: number, amountDue: number): number {
	return Math.max(0, grandTotal - Math.max(0, amountDue));
}
