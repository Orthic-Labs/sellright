import { describe, expect, it } from 'vitest';
import { drawerTotal } from './cart-total';

describe('drawerTotal', () => {
	it('uses the server grand total when a quote hash is present', () => {
		expect(drawerTotal({ subtotal: 10000, discountTotal: 2000, grandTotal: 8500, shippingTotal: 500, quoteHash: 'abc' }, 500)).toEqual({ cents: 8500, label: 'Total' });
	});
	it('adds the shown shipping when the quote carried none (the drawer read has no shipping method)', () => {
		expect(drawerTotal({ subtotal: 2000, discountTotal: 0, grandTotal: 2000, shippingTotal: 0, quoteHash: 'abc' }, 500)).toEqual({ cents: 2500, label: 'Estimated total' });
	});
	it('swaps a different quoted shipping for the shown one', () => {
		expect(drawerTotal({ subtotal: 2000, discountTotal: 0, grandTotal: 2900, shippingTotal: 900, quoteHash: 'abc' }, 500)).toEqual({ cents: 2500, label: 'Estimated total' });
	});
	it('estimates subtotal - discount + shipping without a quote, labelled Estimated total', () => {
		expect(drawerTotal({ subtotal: 10000, discountTotal: 2000, grandTotal: 0, quoteHash: '' }, 500)).toEqual({ cents: 8500, label: 'Estimated total' });
	});
	it('floors at 0', () => {
		expect(drawerTotal({ subtotal: 1000, discountTotal: 5000, grandTotal: 0 }, 0).cents).toBe(0);
	});
});
