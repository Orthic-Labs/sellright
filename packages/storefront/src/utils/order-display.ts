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

/**
 * Status label/color, derived from the native order lifecycle state
 * (`Paid`/`PendingPayment`/`Refunded`/…), the order's `fulfillmentStatus`
 * (all the order LIST carries) and the latest fulfillment's state when the
 * full fulfillments array is present — the same "latest fulfillment wins"
 * convention used by guest order tracking (`services/track-order.service.ts`),
 * so an order looks the same whether viewed signed-in or via a tracking link.
 */
export function getStatusDisplay(
	orderState: string,
	fulfillments: AccountOrderDetail['fulfillments'] | undefined,
	fulfillmentStatus?: string | null,
): { label: string; color: string; description?: string } {
	const latest = fulfillments?.[0];
	if (latest?.state === 'Delivered') return { label: 'Delivered', color: NEUTRAL };
	if (latest?.state === 'Shipped') return { label: 'Shipped', color: NEUTRAL };
	if (fulfillments && fulfillments.length > 1 && fulfillments.some((f) => f.state === 'Shipped')) {
		return { label: 'Partially Shipped', color: NEUTRAL };
	}

	switch (displayOrderState(orderState, fulfillmentStatus)) {
		case 'Delivered':
			return { label: 'Delivered', color: NEUTRAL };
		case 'Shipped':
			return { label: 'Shipped', color: NEUTRAL };
		case 'PartiallyShipped':
			return { label: 'Partially Shipped', color: NEUTRAL };
	}

	switch (orderState) {
		case 'Paid':
			return { label: 'Processing', color: NEUTRAL };
		case 'PendingPayment':
			return { label: 'Payment Pending', color: 'bg-[#fef3c7] text-[#92400e] border-[#fde68a]' };
		case 'Cancelled':
			return { label: 'Cancelled', color: NEUTRAL };
		case 'Refunded':
		case 'PartiallyRefunded':
			return { label: 'Refunded', color: 'bg-[#fee2e2] text-[#991b1b] border-[#fca5a5]' };
		default:
			return { label: orderState, color: NEUTRAL };
	}
}
