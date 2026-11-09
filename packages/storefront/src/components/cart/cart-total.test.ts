import { describe, expect, it } from 'vitest';
import { drawerTotal } from './cart-total';

describe('drawerTotal', () => {
	it('uses the server grand total when a quote hash is present', () => {
		expect(drawerTotal({ subtotal: 10000, discountTotal: 2000, grandTotal: 8500, quoteHash: 'abc' }, 500)).toEqual({ cents: 8500, label: 'Total' });
	});
	it('estimates subtotal - discount + shipping without a quote, labelled Estimated total', () => {
		expect(drawerTotal({ subtotal: 10000, discountTotal: 2000, grandTotal: 0, quoteHash: '' }, 500)).toEqual({ cents: 8500, label: 'Estimated total' });
	});
	it('floors at 0', () => {
		expect(drawerTotal({ subtotal: 1000, discountTotal: 5000, grandTotal: 0 }, 0).cents).toBe(0);
	});
});
