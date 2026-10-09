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

export type BalanceMethod = 'stripe' | 'nmi' | 'sezzle';

/**
 * Methods the shopper can pay a balance with, in display order, from the
 * public store config. Stripe pays through a PaymentIntent the API mints for
 * exactly the amount due (POST /payment-intent) and settles on return
 * (POST /pay { method: 'stripe' }); NMI and Sezzle use the gateway-payment routes.
 */
export function availableBalanceMethods(
	config: { stripeConfigured?: boolean; stripePublishableKey?: string | null; gateways?: ShopConfig['gateways'] } | null | undefined,
): BalanceMethod[] {
	const out: BalanceMethod[] = [];
	if (config?.stripeConfigured && config.stripePublishableKey?.trim()) out.push('stripe');
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

/** Where Stripe sends the shopper back to after a redirect-based method; the
 *  page picks the intent up from the query Stripe appends. */
export function balanceReturnUrl(origin: string, code: string, receiptToken: string): string {
	return `${origin}/orders/${encodeURIComponent(code)}/?rt=${encodeURIComponent(receiptToken)}&pay=balance`;
}

/** The PaymentIntent a Stripe redirect return carries (`payment_intent` +
 *  `redirect_status`). A failed redirect is reported as such, never as a pay. */
export function stripeReturnFrom(search: URLSearchParams): { intentId: string; failed: boolean } | null {
	const intentId = search.get('payment_intent')?.trim();
	if (!intentId || !intentId.startsWith('pi_')) return null;
	return { intentId, failed: search.get('redirect_status') === 'failed' };
}

/**
 * After a balance payment is confirmed, read the order until the balance is
 * gone. Stripe settles through the API (/pay verifies the intent, the webhook
 * is the backstop), so a read right after confirming can still show the old
 * amount due. `read` returns the order's `amountDue` (null = read failed).
 * Resolves true as soon as nothing is due, false when the attempts run out
 * (payment still processing — the page says so and keeps the order readable).
 */
export async function pollBalanceCleared(
	read: () => Promise<number | null>,
	signal: AbortSignal,
	opts: { attempts?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
): Promise<boolean> {
	const attempts = opts.attempts ?? 6;
	const sleep = opts.sleep ?? ((ms, s) => new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		s.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
	}));
	for (let i = 0; i < attempts; i++) {
		if (signal.aborted) return false;
		const due = await read().catch(() => null);
		if (due !== null && due <= 0) return true;
		if (i < attempts - 1) await sleep(Math.min(1000 * (i + 1), 4000), signal);
	}
	return false;
}

/** Result of one reconciliation round for a confirmed Stripe PaymentIntent. */
export type ReconcileOutcome =
	| 'cleared' // the balance is gone: paid
	| 'pending' // reads work but the balance has not cleared yet (still processing; NOT a failure)
	| 'unknown' // neither the settle call nor any read produced an answer (network/server)
	| 'failed' // the API definitively rejected this intent as not paid
	| 'aborted';

/** Only an explicit "this payment did not succeed" answer counts as a definitive
 *  failure (402 Payment Required / 422). Everything else (network, 5xx, 409,
 *  429, ...) is unknown: the money may already have moved, so the shopper is
 *  never invited to pay again on that basis. */
export function classifySettleStatus(status: number | null | undefined): 'failed' | 'unknown' {
	return status === 402 || status === 422 ? 'failed' : 'unknown';
}

/**
 * One bounded reconcile round: settle the intent (idempotent; the webhook is the
 * backstop), then read the order until the balance clears or the attempts run
 * out. Never throws. After a 'pending' / 'unknown' result the page shows an
 * explicit Refresh control that runs another round for the SAME intent — it
 * does not stop forever and it never re-enables payment.
 */
export async function reconcileBalance(args: {
	settle: () => Promise<void>; // rejects with the API error on failure
	read: () => Promise<number | null>; // amountDue, null = read failed
	statusOf: (e: unknown) => number | null;
	signal: AbortSignal;
	attempts?: number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<ReconcileOutcome> {
	const { settle, read, statusOf, signal } = args;
	if (signal.aborted) return 'aborted';
	try {
		await settle();
	} catch (e) {
		if (signal.aborted) return 'aborted';
		if (classifySettleStatus(statusOf(e)) === 'failed') return 'failed';
		// unknown: fall through to the reads, which are the source of truth
	}
	let readOnce = false;
	const cleared = await pollBalanceCleared(async () => {
		const due = await read();
		if (due !== null) readOnce = true;
		return due;
	}, signal, { attempts: args.attempts, sleep: args.sleep });
	if (signal.aborted) return 'aborted';
	if (cleared) return 'cleared';
	return readOnce ? 'pending' : 'unknown';
}
