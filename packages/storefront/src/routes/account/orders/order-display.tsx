import { component$ } from '@qwik.dev/core';
import type { AccountOrderDetail } from '~/sellright/types/account';

export const TruckIcon = component$(() => (
	<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
		<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
	</svg>
));

export const CalendarIcon = component$(() => (
	<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
		<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
	</svg>
));

export const ChevronDownIcon = component$(() => (
	<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
		<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
	</svg>
));

export const PackageIcon = component$(() => (
	<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
		<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
	</svg>
));

/**
 * Status label/color, derived from the native order lifecycle state
 * (`Paid`/`PendingPayment`/`Refunded`/…) plus the latest fulfillment's state
 * when one exists — the same "latest fulfillment wins" convention used by
 * guest order tracking (`services/track-order.service.ts`), so an order looks
 * the same whether viewed signed-in or via a tracking link.
 */
export function getStatusDisplay(
	orderState: string,
	fulfillments: AccountOrderDetail['fulfillments'] | undefined,
): { label: string; color: string; description?: string } {
	const latest = fulfillments?.[0];
	if (latest?.state === 'Delivered') {
		return { label: 'Delivered', color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]' };
	}
	if (latest?.state === 'Shipped') {
		return { label: 'Shipped', color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]' };
	}
	if (fulfillments && fulfillments.length > 1 && fulfillments.some((f) => f.state === 'Shipped')) {
		return { label: 'Partially Shipped', color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]' };
	}

	switch (orderState) {
		case 'Paid':
			return { label: 'Processing', color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]' };
		case 'PendingPayment':
			return { label: 'Payment Pending', color: 'bg-[#fef3c7] text-[#92400e] border-[#fde68a]' };
		case 'Cancelled':
			return { label: 'Cancelled', color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]' };
		case 'Refunded':
		case 'PartiallyRefunded':
			return { label: 'Refunded', color: 'bg-[#fee2e2] text-[#991b1b] border-[#fca5a5]' };
		default:
			return { label: orderState, color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]' };
	}
}

export const getStatusIcon = (
	orderState: string,
	fulfillments?: AccountOrderDetail['fulfillments'],
) => {
	const latest = fulfillments?.[0]?.state?.toLowerCase();
	if (latest === 'shipped' || latest === 'delivered') return <TruckIcon />;
	if (orderState === 'Paid') return <PackageIcon />;
	return <CalendarIcon />;
};

export const formatDate = (dateString: string | null) => {
	if (!dateString) return 'Not yet placed';
	try {
		const date = new Date(dateString);
		if (isNaN(date.getTime())) return 'Invalid Date';
		return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
	} catch {
		return 'Invalid Date';
	}
};

export const getTrackingInfo = (fulfillments: AccountOrderDetail['fulfillments'] | undefined) => {
	const fulfillment = fulfillments?.find((f) => f.trackingCode);
	return fulfillment
		? { hasTracking: true as const, trackingCode: fulfillment.trackingCode, carrier: fulfillment.carrier, state: fulfillment.state }
		: { hasTracking: false as const };
};

/** Whether any line in the order is a pre-order — the native API puts this
 *  flag on each line, not on the order itself (mirrors track-order.service.ts). */
export const isPreOrder = (lines: { isPreOrder: boolean }[]): boolean => lines.some((l) => l.isPreOrder);
