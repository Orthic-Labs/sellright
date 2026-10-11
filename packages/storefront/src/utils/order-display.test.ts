import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayOrderState, getStatusDisplay } from './order-display';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('displayOrderState — payment state folded with fulfillmentStatus', () => {
	it('a Paid order that is fulfilled reads Shipped, delivered reads Delivered', () => {
		expect(displayOrderState('Paid', 'fulfilled')).toBe('Shipped');
		expect(displayOrderState('Paid', 'delivered')).toBe('Delivered');
	});

	it('partial fulfilment reads PartiallyShipped', () => {
		expect(displayOrderState('Paid', 'partially_fulfilled')).toBe('PartiallyShipped');
		expect(displayOrderState('Paid', 'partially_delivered')).toBe('PartiallyShipped');
	});

	it('terminal payment states win over fulfilment', () => {
		for (const state of ['Cancelled', 'Refunded', 'Declined']) {
			expect(displayOrderState(state, 'fulfilled')).toBe(state);
		}
	});

	it('unfulfilled, missing or unknown fulfilment leaves the payment state alone', () => {
		expect(displayOrderState('Paid', 'unfulfilled')).toBe('Paid');
		expect(displayOrderState('Paid', undefined)).toBe('Paid');
		expect(displayOrderState('Paid', null)).toBe('Paid');
		expect(displayOrderState('Paid', 'something_new')).toBe('Paid');
	});
});

describe('getStatusDisplay — the order list (no fulfillments array)', () => {
	it('state Paid + fulfillmentStatus fulfilled shows Shipped, not Processing', () => {
		expect(getStatusDisplay('Paid', undefined, 'fulfilled').label).toBe('Shipped');
	});

	it('delivered and partially fulfilled orders show their own labels', () => {
		expect(getStatusDisplay('Paid', undefined, 'delivered').label).toBe('Delivered');
		expect(getStatusDisplay('Paid', undefined, 'partially_fulfilled').label).toBe('Partially Shipped');
	});

	it('without fulfilment progress the payment-state labels are unchanged', () => {
		expect(getStatusDisplay('Paid', undefined).label).toBe('Processing');
		expect(getStatusDisplay('Paid', undefined, 'unfulfilled').label).toBe('Processing');
		expect(getStatusDisplay('PendingPayment', undefined, 'unfulfilled').label).toBe('Payment Pending');
		expect(getStatusDisplay('Refunded', undefined, 'fulfilled').label).toBe('Refunded');
	});

	it('the order list and the detail page pass fulfillmentStatus through', () => {
		expect(read('src/routes/account/orders/index.tsx')).toContain('getStatusDisplay(order.state, undefined, order.fulfillmentStatus)');
		expect(read('src/routes/account/orders/[code]/index.tsx')).toContain('getStatusDisplay(o.state, o.fulfillments, o.fulfillmentStatus)');
	});
});
