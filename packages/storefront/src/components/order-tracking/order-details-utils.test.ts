import { describe, expect, it } from 'vitest';
import type { TrackedOrder } from '~/sellright/types/content';
import { detectCarrier, getOrderStatus, getTrackingUrl, lineImageSrc } from './order-details-utils';

describe('detectCarrier', () => {
	it('prefers the fulfilment carrier text', () => {
		expect(detectCarrier('anything', 'UPS')).toBe('ups');
		expect(detectCarrier('anything', 'FedEx Ground')).toBe('fedex');
		expect(detectCarrier('anything', 'USPS Priority')).toBe('usps');
		expect(detectCarrier('anything', 'United States Postal Service')).toBe('usps');
	});
	it('does not read "ups" out of an unrelated word', () => {
		expect(detectCarrier('x', 'Groups Courier')).toBeNull();
	});
	it('falls back to the number shape when the carrier is missing or generic', () => {
		expect(detectCarrier('1Z999AA10123456784', null)).toBe('ups');
		expect(detectCarrier('9400111899223197428490', 'Standard Shipping')).toBe('usps');
		expect(detectCarrier('123456789012', undefined)).toBe('fedex');
		expect(detectCarrier('not-a-number')).toBeNull();
	});
});

describe('getTrackingUrl', () => {
	it('links to the detected carrier', () => {
		expect(getTrackingUrl('1Z999AA10123456784')).toBe('https://www.ups.com/track?tracknum=1Z999AA10123456784');
		expect(getTrackingUrl('123456789012', 'FedEx')).toBe('https://www.fedex.com/fedextrack/?trknbr=123456789012');
		expect(getTrackingUrl('9400111899223197428490', 'USPS')).toBe('https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=9400111899223197428490');
	});
	it('keeps the USPS page for an unrecognised carrier (the previous behaviour) and encodes the number', () => {
		expect(getTrackingUrl('abc 1&2')).toBe('https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=abc%201%262');
	});
});

describe('lineImageSrc', () => {
	it('mounts a stored path under /assets and leaves absolute/root URLs alone', () => {
		expect(lineImageSrc({ image: 'a/b.webp' })).toBe('/assets/a/b.webp');
		expect(lineImageSrc({ image: '/assets/a.webp' })).toBe('/assets/a.webp');
		expect(lineImageSrc({ image: 'https://cdn.example/a.webp' })).toBe('https://cdn.example/a.webp');
		expect(lineImageSrc({ image: null })).toBeNull();
		expect(lineImageSrc({})).toBeNull();
	});
});

describe('getOrderStatus — refunds', () => {
	const base = { code: 'X', placedAt: null, currency: 'USD', subtotal: 0, shippingTotal: 0, taxTotal: 0, discountTotal: 0, grandTotal: 0, shippingAddress: null, fulfillments: [], payments: [], lines: [] };
	it('tells a partial refund from a full one', () => {
		expect(getOrderStatus({ ...base, state: 'PartiallyRefunded', displayStatus: 'Refunded' } as TrackedOrder).status).toBe('Partially Refunded');
		expect(getOrderStatus({ ...base, state: 'Refunded', displayStatus: 'Refunded' } as TrackedOrder).status).toBe('Refunded');
	});
});
