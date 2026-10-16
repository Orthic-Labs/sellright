import { describe, expect, it } from 'vitest';
import { cartBannerFor, type ConvertedLookupState } from './cart-banners';

const order = (state: string): ConvertedLookupState => ({
	ok: true,
	order: { code: 'O1', state, grandTotal: 5800, receiptToken: 'rt', currency: 'USD' },
});

describe('cartBannerFor', () => {
	it('shows the normal cart for every non-converted status', () => {
		for (const status of ['active', 'abandoned', 'merged', undefined]) {
			expect(cartBannerFor(status, order('Paid'))).toEqual({ continueCheckout: false, startNewCart: false, message: null });
		}
	});

	it('offers Continue checkout for a converted cart whatever the lookup says — even before it resolves', () => {
		const lookups: ConvertedLookupState[] = [
			null,
			'loading',
			{ ok: false, reason: 'unavailable' },
			{ ok: false, reason: 'not_converted' },
			order('PendingPayment'),
			order('Paid'),
			order('Cancelled'),
			order('Declined'),
		];
		for (const lookup of lookups) expect(cartBannerFor('converted', lookup).continueCheckout).toBe(true);
	});

	it('offers Start a new cart only for a verified settled or cancelled order', () => {
		for (const state of ['Paid', 'PartiallyRefunded', 'Refunded', 'Shipped', 'Delivered', 'Cancelled']) {
			expect(cartBannerFor('converted', order(state)).startNewCart).toBe(true);
		}
	});

	it('gives an unpaid order no escape: not while loading, not on a failed lookup, not PendingPayment, not an unknown state', () => {
		const lookups: ConvertedLookupState[] = [
			null,
			'loading',
			{ ok: false, reason: 'unavailable' },
			{ ok: false, reason: 'not_converted' },
			order('PendingPayment'),
			order('Declined'),
			order('AddingItems'),
			order('SomethingNew'),
		];
		for (const lookup of lookups) expect(cartBannerFor('converted', lookup).startNewCart).toBe(false);
	});
});
