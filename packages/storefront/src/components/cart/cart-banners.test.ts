import { describe, expect, it } from 'vitest';
import { cartBannerFor, type ConvertedLookupState } from './cart-banners';

const order = (state: string): ConvertedLookupState => ({
	ok: true,
	order: { code: 'O1', state, grandTotal: 5800, receiptToken: 'rt', currency: 'USD' },
});

describe('cartBannerFor', () => {
	it('shows the normal cart for every non-converted status', () => {
		for (const status of ['active', 'abandoned', 'merged', undefined]) {
			expect(cartBannerFor(status, order('Paid'))).toEqual({ continueCheckout: false, startNewCart: false, editCart: false, message: null });
		}
	});

	it('offers Continue checkout for a converted cart whatever the lookup says — except a cancelled order', () => {
		const lookups: ConvertedLookupState[] = [
			null,
			'loading',
			{ ok: false, reason: 'unavailable' },
			{ ok: false, reason: 'not_converted' },
			order('PendingPayment'),
			order('Paid'),
			order('Declined'),
		];
		for (const lookup of lookups) expect(cartBannerFor('converted', lookup).continueCheckout).toBe(true);
		expect(cartBannerFor('converted', order('Cancelled')).continueCheckout).toBe(false);
	});

	it('offers Start a new cart only for a verified settled order', () => {
		for (const state of ['Paid', 'PartiallyRefunded', 'Refunded', 'Shipped', 'Delivered']) {
			expect(cartBannerFor('converted', order(state)).startNewCart).toBe(true);
		}
		expect(cartBannerFor('converted', order('Cancelled')).startNewCart).toBe(false);
	});

	it('#370: offers Edit cart (items kept) for an unpaid or cancelled order, never for a paid one', () => {
		expect(cartBannerFor('converted', order('PendingPayment')).editCart).toBe(true);
		expect(cartBannerFor('converted', order('Cancelled')).editCart).toBe(true);
		for (const state of ['Paid', 'PartiallyRefunded', 'Refunded', 'Shipped', 'Delivered']) {
			expect(cartBannerFor('converted', order(state)).editCart).toBe(false);
		}
		for (const lookup of [null, 'loading', { ok: false, reason: 'unavailable' }, order('SomethingNew')] as ConvertedLookupState[]) {
			expect(cartBannerFor('converted', lookup).editCart).toBe(false);
		}
	});

	it('never offers an empty new cart for an unpaid order: not while loading, not on a failed lookup, not PendingPayment, not an unknown state', () => {
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
