import { component$ } from '@qwik.dev/core';
import type { AccountOrderDetail } from '~/sellright/types/account';
import { getStatusDisplay, resolveOrderDisplayState, type PreOrderFacts } from '~/utils/order-display';
import { getTrackingUrl } from '~/components/order-tracking/order-details-utils';

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

export { getStatusDisplay };

export const getStatusIcon = (
	orderState: string,
	fulfillments?: AccountOrderDetail['fulfillments'],
	fulfillmentStatus?: string | null,
) => {
	if (['Delivered', 'Shipped', 'PartiallyShipped'].includes(resolveOrderDisplayState(orderState, fulfillments, fulfillmentStatus))) return <TruckIcon />;
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
		? {
			hasTracking: true as const, trackingCode: fulfillment.trackingCode, carrier: fulfillment.carrier, state: fulfillment.state,
			// The carrier's own tracking page (USPS/FedEx/UPS by the fulfilment's carrier, else by the number's shape).
			url: getTrackingUrl(fulfillment.trackingCode as string, fulfillment.carrier),
		}
		: { hasTracking: false as const };
};

/** What the order LIST row carries about its tracking (`trackingCode` + `carrier` of the newest tracked fulfilment). */
export const listTrackingInfo = (order: { trackingCode?: string | null; carrier?: string | null }) =>
	order.trackingCode
		? { hasTracking: true as const, trackingCode: order.trackingCode, carrier: order.carrier ?? null, url: getTrackingUrl(order.trackingCode, order.carrier) }
		: { hasTracking: false as const };

/** Pre-order facts of an order DETAIL's lines (the detail has no order-level flag): the latest line ship date and the
 *  distinct ship-date wordings, as the list endpoint summarises them. */
export const preOrderFactsOfLines = (lines: Array<{ isPreOrder: boolean; shipDate?: string | null; shipDateLabel?: string | null }>): PreOrderFacts => {
	const pre = lines.filter((l) => l.isPreOrder);
	const times = pre.flatMap((l) => (l.shipDate ? [new Date(l.shipDate).getTime()] : [])).filter((n) => !Number.isNaN(n));
	const labels = [...new Set(pre.flatMap((l) => (l.shipDateLabel ? [l.shipDateLabel] : [])))];
	return { isPreOrder: pre.length > 0, shipDate: times.length ? new Date(Math.max(...times)).toISOString() : null, shipDateLabel: labels.length ? labels.join('; ') : null };
};

/** Whether any line in the order is a pre-order — the native API puts this
 *  flag on each line, not on the order itself (mirrors track-order.service.ts). */
export const isPreOrder = (lines: { isPreOrder: boolean }[]): boolean => lines.some((l) => l.isPreOrder);

/** The fields `GET /v1/shop/account/orders` adds for the history cards (#393). Declared here, optional, so the page
 *  compiles against a client generated before them; once regenerated the generated type already carries them. */
export type OrderHistoryFacts = {
	subtotal?: number; shippingTotal?: number; taxTotal?: number; discountTotal?: number; shippingMethodName?: string | null;
	trackingCode?: string | null; carrier?: string | null;
	isPreOrder?: boolean; shipDate?: string | null; shipDateLabel?: string | null;
	items?: Array<{
		sku: string; name: string; productName: string | null; quantity: number; unitPrice: number; lineTotal: number;
		image: string | null; isPreOrder: boolean; shipDate: string | null; shipDateLabel: string | null;
	}>;
};

export { canReviewLine } from '~/utils/order-display';
