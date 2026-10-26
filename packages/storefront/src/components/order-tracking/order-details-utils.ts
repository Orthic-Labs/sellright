import { shippingDateText } from '~/utils/shipping-label';
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

export function getPreOrderShippingText(order: TrackedOrder): string | null {
  const labels = [...new Set(order.lines.filter((line) => line.isPreOrder && line.shipDateLabel).map((line) => shippingDateText(line)))];
  if (labels.length) return labels.join('; ');
  const latest = getLatestPreOrderShipDate(order);
  return latest ? formatShipDate(latest) : null;
}

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
				const shipText = getPreOrderShippingText(order);
				const description = shipText
					? `Expected to ship around ${shipText}`
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
			// `displayStatus` folds PartiallyRefunded into Refunded (sellright/content.ts); the order's own state tells them apart.
			if (order.state === 'PartiallyRefunded') return { ...base, status: 'Partially Refunded', description: 'Part of your order has been refunded.', icon: '↩️' };
			return { ...base, status: 'Refunded', description: 'Your order has been refunded.', icon: '↩️' };
		case 'Cancelled':
			return { ...base, status: 'Cancelled', description: 'This order has been cancelled.', icon: '❌' };
		default:
			return { ...base, status: 'Processing', description: 'Your order is being processed.', icon: '⏳' };
	}
};

export type TrackingCarrier = 'usps' | 'fedex' | 'ups';

/** The carrier a tracking number belongs to: the fulfilment's own `carrier` text when it names one, else the number's
 *  shape (same rules as the API's `inferCarrier`, packages/api/src/routes/admin-order-utils.ts, and the admin tracking
 *  import). Null when neither says. */
export const detectCarrier = (trackingCode: string, carrier?: string | null): TrackingCarrier | null => {
	const named = (carrier ?? '').toLowerCase();
	if (/\bups\b|united parcel/.test(named)) return 'ups';
	if (/fedex|fed ex|federal express/.test(named)) return 'fedex';
	if (/\busps\b|postal service/.test(named)) return 'usps';
	const x = trackingCode.replace(/\s/g, '').toUpperCase();
	if (/^1Z[0-9A-Z]{16}$/.test(x)) return 'ups';
	if (/^9[24]\d{18,20}$/.test(x)) return 'usps';
	if (/^(94|93|92|95|420)\d{20,}$/.test(x) || /^[A-Z]{2}\d{9}US$/.test(x)) return 'usps';
	if (/^\d{12}$/.test(x) || /^\d{15}$/.test(x) || /^\d{20,22}$/.test(x)) return 'fedex';
	return null;
};

/** Public tracking page for a number. An unrecognised carrier keeps the previous behaviour (USPS), so the link
 *  never disappears for the stores' predominantly-USPS shipments. */
export const getTrackingUrl = (trackingCode: string, carrier?: string | null) => {
	const code = encodeURIComponent(trackingCode.trim());
	switch (detectCarrier(trackingCode, carrier)) {
		case 'ups':
			return `https://www.ups.com/track?tracknum=${code}`;
		case 'fedex':
			return `https://www.fedex.com/fedextrack/?trknbr=${code}`;
		default:
			return `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${code}`;
	}
};

export const getMaskedTrackingCode = (trackingCode: string) => {
	const normalized = trackingCode.trim();
	const suffix = normalized.slice(-8);
	return `...${suffix}`;
};

/** Display URL of a tracked line's image: the API sends a stored asset path (`/v1/shop/track` lines carry `image`,
 *  same as the receipt); mirrors the API's `/assets/<path>` mount unless it is already absolute or root-relative.
 *  The line type does not declare `image` yet (`~/sellright/types/content`), so it is read defensively. */
export const lineImageSrc = (line: object): string | null => {
	const image = (line as { image?: unknown }).image;
	if (typeof image !== 'string' || !image) return null;
	return /^(https?:\/\/|\/)/.test(image) ? image : `/assets/${image}`;
};
