import { classifyOrderState } from '~/services/order-state';

/**
 * Zero-due order still PendingPayment: settle it. True ONLY on proof: the settle response carries a settled order state, or (it failed, answered a non-settled state, or the
 * server said "already covered", which the provider reports as null) an order read shows a settled state. A
 * timeout, network failure or rejection with no settled read-back is `false` — the caller keeps a retry and never
 * announces "paid".
 */
export const settleZeroDueProven = async (
	code: string,
	receiptToken: string,
	deps: {
		settle: (code: string, receiptToken?: string) => Promise<{ state?: string | null } | null | undefined>;
		readOrder: (code: string, receiptToken?: string) => Promise<{ state?: string | null }>;
	},
): Promise<boolean> => {
	try {
		// POST /pay answers 200 for Failed/Declined/PendingPayment too: only a settled order state is proof.
		const paid = await deps.settle(code, receiptToken || undefined);
		if (paid && classifyOrderState(paid.state) === 'settled') return true;
	} catch {
		/* ambiguous: the server may or may not have settled it — verify below */
	}
	try {
		const order = await deps.readOrder(code, receiptToken || undefined);
		return classifyOrderState(order.state) === 'settled';
	} catch {
		return false;
	}
};
