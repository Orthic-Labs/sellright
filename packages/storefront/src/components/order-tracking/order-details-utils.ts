import type { TrackedOrder, TrackedOrderDisplayStatus } from '~/sellright/types/content';

export const hasPreOrderItems = (order: TrackedOrder) => order.lines.some((line) => line.isPreOrder);

export const getLatestPreOrderShipDate = (order: TrackedOrder): Date | null => {
	const preOrderDates = order.lines
		.filter((line) => line.isPreOrder && line.shipDate)
		.map((line) => new Date(line.shipDate as string))
		.filter((date) => !isNaN(date.getTime()));

	if (preOrderDates.length === 0) return null;

	const timestamps = preOrderDates.map((date) => date.getTime());
	return new Date(Math.max(...timestamps));
};

export const formatShipDate = (date: Date) => {
	return date.toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	});
};

export const getTrackingInfo = (order: TrackedOrder) => {
	const withTracking = order.fulfillments.find((f) => f.trackingCode);
	if (!withTracking) return { hasTracking: false as const };
	return {
		hasTracking: true as const,
		trackingCode: withTracking.trackingCode as string,
		carrier: withTracking.carrier || 'Standard Shipping',
		status: withTracking.state,
		shipDate: withTracking.updatedAt,
	};
};

interface OrderStatusView {
	status: string;
	description: string;
	color: string;
	bgColor: string;
	icon: string;
}

/** Switches on `TrackedOrder.displayStatus` — a UI-only status derived (see
 *  `~/sellright/content` `deriveDisplayStatus`) from the API's real
 *  order.state + fulfillment states, never a fabricated order state. */
export const getOrderStatus = (order: TrackedOrder): OrderStatusView => {
	const base = { color: 'text-[#141210]', bgColor: 'bg-[#F5F0E8]' };
	const status: TrackedOrderDisplayStatus = order.displayStatus;
	switch (status) {
		case 'AwaitingPayment':
			return { ...base, status: 'Awaiting Payment', description: 'We\'re waiting for payment confirmation.', icon: '⏳' };
		case 'Processing': {
			if (hasPreOrderItems(order)) {
				const latestShipDate = getLatestPreOrderShipDate(order);
				const description = latestShipDate
					? `Expected to ship around ${formatShipDate(latestShipDate)}`
					: 'Expected ship date to be announced';
				return { ...base, status: 'Pre-ordered', description, icon: '🎯' };
			}
			return { ...base, status: 'Processing', description: 'Your payment has been processed and your order is being prepared.', icon: '💳' };
		}
		case 'PartiallyShipped':
			return { ...base, status: 'Partially Shipped', description: 'Some items from your order have been shipped.', icon: '📦' };
		case 'Shipped':
			return { ...base, status: 'Shipped', description: 'Your order has been shipped and is on its way.', icon: '🚛' };
		case 'Delivered':
			return { ...base, status: 'Delivered', description: 'Your order has been delivered.', icon: '✅' };
		case 'Refunded':
			return { ...base, status: 'Refunded', description: 'Your order has been refunded.', icon: '↩️' };
		case 'Cancelled':
			return { ...base, status: 'Cancelled', description: 'This order has been cancelled.', icon: '❌' };
		default:
			return { ...base, status: 'Processing', description: 'Your order is being processed.', icon: '⏳' };
	}
};

export const getTrackingUrl = (trackingCode: string) =>
	`https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${trackingCode}`;

export const getMaskedTrackingCode = (trackingCode: string) => {
	const normalized = trackingCode.trim();
	const suffix = normalized.slice(-8);
	return `...${suffix}`;
};
