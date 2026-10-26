import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayOrderState, getStatusDisplay, preOrderShipText, resolveOrderDisplayState } from './order-display';

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
		expect(read('src/routes/account/orders/index.tsx')).toContain('getStatusDisplay(order.state, undefined, order.fulfillmentStatus, preOrder)');
		expect(read('src/routes/account/orders/[code]/index.tsx')).toContain('getStatusDisplay(o.state, o.fulfillments, o.fulfillmentStatus, preOrderFactsOfLines(o.lines))');
	});
});

describe('status precedence — terminal payment state, then aggregate fulfilment, then individual fulfilments', () => {
	const ful = (...states: string[]) => states.map((state) => ({ state })) as never;

	it('a partially fulfilled order with one Shipped fulfilment reads Partially Shipped, not Shipped', () => {
		expect(getStatusDisplay('Paid', ful('Shipped'), 'partially_fulfilled').label).toBe('Partially Shipped');
		expect(resolveOrderDisplayState('Paid', ful('Shipped'), 'partially_fulfilled')).toBe('PartiallyShipped');
	});

	it('refunded and cancelled orders keep their payment label whatever the fulfilments say', () => {
		expect(getStatusDisplay('Refunded', ful('Delivered'), 'delivered').label).toBe('Refunded');
		expect(getStatusDisplay('Refunded', ful('Delivered')).label).toBe('Refunded');
		expect(getStatusDisplay('Cancelled', ful('Delivered'), 'delivered').label).toBe('Cancelled');
		expect(getStatusDisplay('Cancelled', ful('Delivered')).label).toBe('Cancelled');
		expect(resolveOrderDisplayState('Cancelled', ful('Delivered'), 'delivered')).toBe('Cancelled');
	});

	it('the aggregate wins over the latest fulfilment when both are present', () => {
		expect(getStatusDisplay('Paid', ful('Shipped'), 'delivered').label).toBe('Delivered');
		expect(getStatusDisplay('Paid', ful('Delivered'), 'unfulfilled').label).toBe('Processing');
	});

	it('individual fulfilments are consulted only when the aggregate is unavailable', () => {
		expect(getStatusDisplay('Paid', ful('Delivered'), null).label).toBe('Delivered');
		expect(getStatusDisplay('Paid', ful('Shipped'), undefined).label).toBe('Shipped');
		expect(getStatusDisplay('Paid', ful('Pending', 'Shipped')).label).toBe('Partially Shipped');
		expect(getStatusDisplay('Paid', ful()).label).toBe('Processing');
	});

	it('the icon uses the same resolver as the label', () => {
		const src = read('src/routes/account/orders/order-display.tsx');
		expect(src).toContain('resolveOrderDisplayState(orderState, fulfillments, fulfillmentStatus)');
		expect(src).not.toContain('fulfillments?.[0]');
	});
});

describe('getStatusDisplay — refunds and pre-orders (#393)', () => {
	it('a partially refunded order reads "Partially Refunded", a refunded one "Refunded"', () => {
		expect(getStatusDisplay('PartiallyRefunded', undefined, null).label).toBe('Partially Refunded');
		expect(getStatusDisplay('Refunded', undefined, null).label).toBe('Refunded');
	});

	it('a paid, unshipped pre-order reads "Pre-ordered" with its ship date', () => {
		const out = getStatusDisplay('Paid', undefined, 'unfulfilled', { isPreOrder: true, shipDate: '2027-03-15T00:00:00.000Z' });
		expect(out.label).toBe('Pre-ordered');
		expect(out.description).toMatch(/^Expected to ship around March 1[45], 2027$/);
	});

	it('the merchant ship-date wording wins; no date at all says it is to be announced', () => {
		expect(preOrderShipText({ isPreOrder: true, shipDate: '2027-03-15T00:00:00.000Z', shipDateLabel: 'Spring 2027' })).toBe('Expected to ship around Spring 2027');
		expect(preOrderShipText({ isPreOrder: true })).toBe('Expected ship date to be announced');
	});

	it('a shipped pre-order shows its shipping status, and a plain paid order stays Processing', () => {
		expect(getStatusDisplay('Paid', undefined, 'fulfilled', { isPreOrder: true }).label).toBe('Shipped');
		expect(getStatusDisplay('Paid', undefined, 'unfulfilled', { isPreOrder: false }).label).toBe('Processing');
	});
});
