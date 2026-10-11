import { describe, expect, it } from 'vitest';
import { decideCheckoutEntry, decideCheckoutStage, decideResumeStage, defaultPaymentMethod, EMPTY_ORDER_STATE, shouldApplyConfigDefault, shouldRecoverExistingOrder, shouldResumeLate } from './checkout-stage';

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

describe('decideResumeStage', () => {
	it('PendingPayment with money due is payable', () => {
		expect(decideResumeStage('PendingPayment', 5800)).toEqual({ kind: 'payable' });
	});

	it('PendingPayment with nothing due is settled by the zero-due path', () => {
		expect(decideResumeStage('PendingPayment', 0)).toEqual({ kind: 'zero-due' });
	});

	it('every settled state goes to confirmation', () => {
		for (const state of ['Paid', 'PartiallyRefunded', 'Refunded', 'PartiallyShipped', 'Shipped', 'Delivered']) {
			expect(decideResumeStage(state, 5800)).toEqual({ kind: 'settled' });
		}
	});

	it('Cancelled is cancelled whatever the total — never payable', () => {
		expect(decideResumeStage('Cancelled', 5800)).toEqual({ kind: 'cancelled' });
		expect(decideResumeStage('Cancelled', 0)).toEqual({ kind: 'cancelled' });
	});

	it('Declined, AddingItems, unseen and missing states are a retryable error, never payable', () => {
		for (const state of ['Declined', 'AddingItems', 'SomethingNew', '', undefined, null]) {
			expect(decideResumeStage(state, 5800)).toEqual({ kind: 'error' });
		}
	});

	it('the new-order decision still sends a Cancelled order to the card form — which is why resume has its own', () => {
		expect(decideCheckoutStage({ state: 'Cancelled', grandTotal: 5800 })).toEqual({ kind: 'card-required' });
	});
});

describe('decideCheckoutEntry', () => {
	it('a converted cart resumes, read ok or not', () => {
		expect(decideCheckoutEntry({ status: 'converted', readFailed: false, hasToken: true })).toBe('resume');
		expect(decideCheckoutEntry({ status: 'converted', readFailed: true, hasToken: true })).toBe('resume');
	});

	it('a FAILED read with a cart token never selects the normal checkout, whatever the stale mirror says', () => {
		expect(decideCheckoutEntry({ status: undefined, readFailed: true, hasToken: true })).toBe('probe');
		expect(decideCheckoutEntry({ status: 'active', readFailed: true, hasToken: true })).toBe('probe');
	});

	it('a successful read of an active cart, or no cart at all, is the normal checkout', () => {
		expect(decideCheckoutEntry({ status: 'active', readFailed: false, hasToken: true })).toBe('normal');
		expect(decideCheckoutEntry({ status: undefined, readFailed: false, hasToken: false })).toBe('normal');
		expect(decideCheckoutEntry({ status: undefined, readFailed: true, hasToken: false })).toBe('normal');
	});
});

describe('shouldResumeLate (conversion discovered after initialisation)', () => {
	const base = { status: 'converted', resume: 'none', orderCode: '', pageLoading: false, processing: false };

	it('fires for a converted cart once the page is initialised, regardless of form or cart-line state', () => {
		expect(shouldResumeLate(base)).toBe(true);
	});

	it('does not fire for any other status', () => {
		for (const status of ['active', 'merged', undefined]) expect(shouldResumeLate({ ...base, status })).toBe(false);
	});

	it('does not fire while the entry sequence or a PLACE ORDER is running (both resume on their own)', () => {
		expect(shouldResumeLate({ ...base, pageLoading: true })).toBe(false);
		expect(shouldResumeLate({ ...base, processing: true })).toBe(false);
	});

	it('does not fire when a resume view is already up or this tab already holds its own order', () => {
		for (const resume of ['loading', 'payable', 'error', 'cancelled', 'settled']) expect(shouldResumeLate({ ...base, resume })).toBe(false);
		expect(shouldResumeLate({ ...base, orderCode: 'ORD-A' })).toBe(false);
		expect(shouldResumeLate({ ...base, orderCode: 'ORD-A', phase: 'paying' })).toBe(false);
	});

	it('fires for an own order whose payment initialisation failed (phase error), form and lines irrelevant', () => {
		expect(shouldResumeLate({ ...base, orderCode: 'ORD-A', phase: 'error' })).toBe(true);
	});
});

describe('shouldRecoverExistingOrder (PLACE ORDER failed after the order existed)', () => {
	it('an existing order in error is recovered through resume', () => {
		expect(shouldRecoverExistingOrder({ phase: 'error', orderCode: 'ORD-A', convertedCart: false })).toBe(true);
	});

	it('no order, a working payment view, or the converted-cart refusal is not', () => {
		expect(shouldRecoverExistingOrder({ phase: 'error', orderCode: '', convertedCart: false })).toBe(false);
		expect(shouldRecoverExistingOrder({ phase: 'paying', orderCode: 'ORD-A', convertedCart: false })).toBe(false);
		expect(shouldRecoverExistingOrder({ phase: 'error', orderCode: 'ORD-A', convertedCart: true })).toBe(false);
	});
});

describe('shop-config default method (applied once)', () => {
	it('prefers stripe > nmi > sezzle, null when nothing is configured', () => {
		expect(defaultPaymentMethod({ stripeConfigured: true, gateways: { nmi: {}, sezzle: {} } })).toBe('stripe');
		expect(defaultPaymentMethod({ stripeConfigured: false, gateways: { nmi: {}, sezzle: {} } })).toBe('nmi');
		expect(defaultPaymentMethod({ gateways: { sezzle: {} } })).toBe('sezzle');
		expect(defaultPaymentMethod({ gateways: {} })).toBeNull();
		expect(defaultPaymentMethod(null)).toBeNull();
	});

	it('the default is applied only by the first completion — the later one of two overlapping responses is ignored', () => {
		let applied = false;
		let method = 'unset';
		const complete = (cfg: Parameters<typeof defaultPaymentMethod>[0]) => {
			if (!shouldApplyConfigDefault(applied)) return;
			applied = true;
			const m = defaultPaymentMethod(cfg);
			if (m) method = m;
		};
		complete({ stripeConfigured: true, gateways: { nmi: {} } }); // first response: stripe default
		expect(method).toBe('stripe');
		method = 'nmi'; // the shopper switches
		complete({ stripeConfigured: true, gateways: { nmi: {} } }); // late duplicate response
		expect(method).toBe('nmi');
	});
});

describe('EMPTY_ORDER_STATE (every exit from a resume state)', () => {
	it('clears code, receipt token, client secret, phase (method lock), method, totals, resume view and errors', () => {
		expect(EMPTY_ORDER_STATE).toMatchObject({
			phase: 'idle',
			code: '',
			receiptToken: '',
			clientSecret: '',
			method: null,
			grandTotal: 0,
			shownTotal: 0,
			resume: 'none',
			convertedCart: false,
			stockConflict: false,
			error: null,
			paymentError: null,
		});
		expect(EMPTY_ORDER_STATE.resumeLines).toEqual([]);
	});
});
