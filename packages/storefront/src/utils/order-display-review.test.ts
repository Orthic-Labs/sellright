import { describe, expect, it } from 'vitest';
import { canReviewLine } from './order-display';

const shipped = { state: 'Paid', fulfillments: [{ state: 'shipped', trackingCode: null, carrier: null, updatedAt: null }], fulfillmentStatus: null };
const delivered = { state: 'Paid', fulfillments: [{ state: 'delivered', trackingCode: null, carrier: null, updatedAt: null }], fulfillmentStatus: null };
const processing = { state: 'Paid', fulfillments: [], fulfillmentStatus: null };

describe('canReviewLine', () => {
	it('offers a review for shipped/delivered lines not yet reviewed', () => {
		expect(canReviewLine(shipped, { productSlug: 'x', reviewed: false })).toBe(true);
		expect(canReviewLine(delivered, { productSlug: 'x', reviewed: false })).toBe(true);
	});
	it('hides it when already reviewed, unfulfilled, or the product is gone', () => {
		expect(canReviewLine(delivered, { productSlug: 'x', reviewed: true })).toBe(false);
		expect(canReviewLine(processing, { productSlug: 'x', reviewed: false })).toBe(false);
		expect(canReviewLine(delivered, { productSlug: null, reviewed: false })).toBe(false);
	});
	it('works from an order history row (#315): fulfillmentStatus only, no fulfillment rows', () => {
		const row = (fulfillmentStatus: string | null) => ({ state: 'Paid', fulfillments: [], fulfillmentStatus });
		expect(canReviewLine(row('delivered'), { productSlug: 'x', reviewed: false })).toBe(true);
		expect(canReviewLine(row('fulfilled'), { productSlug: 'x', reviewed: false })).toBe(true);
		expect(canReviewLine(row('unfulfilled'), { productSlug: 'x', reviewed: false })).toBe(false);
		expect(canReviewLine(row('delivered'), { productSlug: 'x', reviewed: true })).toBe(false);
		expect(canReviewLine(row('delivered'), { productSlug: undefined, reviewed: undefined })).toBe(false);
	});
});
