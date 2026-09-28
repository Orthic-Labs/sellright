import { describe, expect, it } from 'vitest';
import { decideCheckoutStage } from './checkout-stage';

describe('decideCheckoutStage', () => {
	it('routes a non-zero PendingPayment order to card-required', () => {
		expect(decideCheckoutStage({ state: 'PendingPayment', grandTotal: 5800 })).toEqual({ kind: 'card-required' });
	});

	it('routes an already-Paid order straight to paid, no settle call needed', () => {
		expect(decideCheckoutStage({ state: 'Paid', grandTotal: 5800 })).toEqual({ kind: 'paid', needsSettle: false });
	});

	it('routes a zero-due order still PendingPayment to paid, needing a settle call', () => {
		expect(decideCheckoutStage({ state: 'PendingPayment', grandTotal: 0 })).toEqual({ kind: 'paid', needsSettle: true });
	});

	it('prefers state Paid over needsSettle when both a zero total AND Paid are true', () => {
		// A gift card covering the whole total settles server-side in the same
		// response — there is nothing left to call /pay for.
		expect(decideCheckoutStage({ state: 'Paid', grandTotal: 0 })).toEqual({ kind: 'paid', needsSettle: false });
	});

	it('never routes a non-zero total to paid, regardless of a stray state value', () => {
		expect(decideCheckoutStage({ state: 'AddingItems', grandTotal: 100 })).toEqual({ kind: 'card-required' });
	});
});
