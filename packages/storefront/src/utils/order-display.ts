import type { AccountOrderDetail } from '~/sellright/types/account';

/**
 * The API keeps an order's payment lifecycle (`state`: PendingPayment, Paid,
 * PartiallyRefunded, Refunded, Cancelled, …) separate from its fulfilment
 * progress (`fulfillmentStatus`). Customer-facing views show ONE status, so
 * derive it from both — otherwise a shipped order keeps reading "Processing".
 * Terminal payment states (Cancelled, Refunded, Declined) win over fulfilment.
 */
export function displayOrderState(state: string, fulfillmentStatus?: string | null): string {
	if (state === 'Cancelled' || state === 'Refunded' || state === 'Declined') return state;
	switch (fulfillmentStatus) {
		case 'delivered':
			return 'Delivered';
		case 'partially_fulfilled':
		case 'partially_delivered':
			return 'PartiallyShipped';
		case 'fulfilled':
			return 'Shipped';
	}
	return state;
}

const NEUTRAL = 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]';

const TERMINAL_PAYMENT_STATES = new Set(['Cancelled', 'Refunded', 'Declined']);

/**
 * The one status an order shows, in a fixed precedence:
 *  1. terminal payment states (Cancelled, Refunded, Declined),
 *  2. the order's aggregate `fulfillmentStatus` when the API supplied one,
 *  3. the individual fulfilments, only when the aggregate is unavailable
 *     (latest fulfilment Delivered/Shipped, else several fulfilments with a
 *     shipped one = partially shipped; the convention used by guest order
 *     tracking in `services/track-order.service.ts`),
 *  4. the payment state itself.
 * Returns `Delivered` | `Shipped` | `PartiallyShipped` or the payment state.
 * Labels and icons both read this, so they cannot disagree.
 */
export function resolveOrderDisplayState(
	orderState: string,
	fulfillments: AccountOrderDetail['fulfillments'] | undefined,
	fulfillmentStatus?: string | null,
): string {
	if (TERMINAL_PAYMENT_STATES.has(orderState)) return orderState;
	if (fulfillmentStatus) return displayOrderState(orderState, fulfillmentStatus);
	const latest = fulfillments?.[0]?.state?.toLowerCase();
	if (latest === 'delivered') return 'Delivered';
	if (latest === 'shipped') return 'Shipped';
	if (fulfillments && fulfillments.length > 1 && fulfillments.some((f) => f.state?.toLowerCase() === 'shipped')) return 'PartiallyShipped';
	return orderState;
}

/** The pre-order facts an order (list row or detail) carries: any line pre-ordered, the latest ship date, and the
 *  merchant's own ship-date wording (shipDateLabel wins over the date, as in `shippingDateText`). */
export type PreOrderFacts = { isPreOrder: boolean; shipDate?: string | null; shipDateLabel?: string | null };

/** previous-platform parity (account history `getStatusDisplay`): "Expected to ship around <date>" for a pre-order, or
 *  "Expected ship date to be announced" when no date is known. */
export function preOrderShipText(pre: PreOrderFacts): string {
	const label = pre.shipDateLabel?.trim();
	if (label) return `Expected to ship around ${label}`;
	const date = pre.shipDate ? new Date(pre.shipDate) : null;
	if (date && !Number.isNaN(date.getTime())) {
		return `Expected to ship around ${date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`;
	}
	return 'Expected ship date to be announced';
}

/**
 * Status label/color. See `resolveOrderDisplayState` for the precedence between
 * the native payment state (`Paid`/`PendingPayment`/`Refunded`/…), the order's
 * aggregate `fulfillmentStatus` (all the order LIST carries) and the full
 * fulfillments array (detail page only).
 */
export function getStatusDisplay(
	orderState: string,
	fulfillments: AccountOrderDetail['fulfillments'] | undefined,
	fulfillmentStatus?: string | null,
	preOrder?: PreOrderFacts,
): { label: string; color: string; description?: string } {
	switch (resolveOrderDisplayState(orderState, fulfillments, fulfillmentStatus)) {
		case 'Delivered':
			return { label: 'Delivered', color: NEUTRAL };
		case 'Shipped':
			return { label: 'Shipped', color: NEUTRAL };
		case 'PartiallyShipped':
			return { label: 'Partially Shipped', color: NEUTRAL };
	}

	switch (orderState) {
		case 'Paid':
			// Paid, nothing shipped yet, and a pre-order line: "Pre-ordered" with its ship date (the previous platform's PaymentSettled + isPreOrder).
			if (preOrder?.isPreOrder) return { label: 'Pre-ordered', color: NEUTRAL, description: preOrderShipText(preOrder) };
			return { label: 'Processing', color: NEUTRAL };
		case 'PendingPayment':
			return { label: 'Payment Pending', color: 'bg-[#fef3c7] text-[#92400e] border-[#fde68a]' };
		case 'Cancelled':
			return { label: 'Cancelled', color: NEUTRAL };
		case 'Refunded':
			return { label: 'Refunded', color: 'bg-[#fee2e2] text-[#991b1b] border-[#fca5a5]' };
		case 'PartiallyRefunded':
			return { label: 'Partially Refunded', color: 'bg-[#fee2e2] text-[#991b1b] border-[#fca5a5]' };
		default:
			return { label: orderState, color: NEUTRAL };
	}
}

/** A fulfilled/delivered order line whose product the customer has not reviewed yet gets a "Write a review" link
 *  (the API reports `reviewed`; a line whose product is gone has no slug and no link). */
export const canReviewLine = (
	order: Pick<AccountOrderDetail, 'state' | 'fulfillments'> & { fulfillmentStatus?: string | null },
	line: { productSlug?: string | null; reviewed?: boolean },
): boolean =>
	!!line.productSlug && !line.reviewed
	&& ['Delivered', 'Shipped', 'PartiallyShipped'].includes(resolveOrderDisplayState(order.state, order.fulfillments, order.fulfillmentStatus));
