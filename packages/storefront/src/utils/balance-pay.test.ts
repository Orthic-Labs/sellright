import { describe, expect, it } from 'vitest';
import { alreadyPaidCents, availableBalanceMethods, balancePageState, receiptTokenFrom, wantsBalancePay } from './balance-pay';

describe('balancePageState', () => {
	const paid = (amountDue: number, state = 'Paid') => ({ state, amountDue });
	it('is invalid without a receipt token or on 404/401/403', () => {
		expect(balancePageState({ hasToken: false, order: paid(500) })).toBe('invalid');
		expect(balancePageState({ hasToken: true, errorStatus: 404 })).toBe('invalid');
		expect(balancePageState({ hasToken: true, errorStatus: 401 })).toBe('invalid');
		expect(balancePageState({ hasToken: true, errorStatus: 403 })).toBe('invalid');
	});
	it('is unavailable on other load failures', () => {
		expect(balancePageState({ hasToken: true, errorStatus: 500 })).toBe('unavailable');
		expect(balancePageState({ hasToken: true })).toBe('unavailable');
	});
	it('is due for Paid / PartiallyRefunded orders with a positive balance', () => {
		expect(balancePageState({ hasToken: true, order: paid(1000) })).toBe('due');
		expect(balancePageState({ hasToken: true, order: paid(1, 'PartiallyRefunded') })).toBe('due');
	});
	it('is settled right after paying and nothing-due otherwise', () => {
		expect(balancePageState({ hasToken: true, order: paid(0), justPaid: true })).toBe('settled');
		expect(balancePageState({ hasToken: true, order: paid(0) })).toBe('nothing-due');
		expect(balancePageState({ hasToken: true, order: { state: 'Paid' } })).toBe('nothing-due');
	});
	it('is not-payable for unpaid, cancelled and refunded orders even with a due amount', () => {
		for (const state of ['PendingPayment', 'Cancelled', 'Refunded']) {
			expect(balancePageState({ hasToken: true, order: paid(500, state) })).toBe('not-payable');
		}
	});
});

describe('availableBalanceMethods', () => {
	const nmi = { tokenizationKey: 'k', mode: 'test' as const, environment: 'sandbox' as const };
	it('lists only configured gateways, never Stripe', () => {
		expect(availableBalanceMethods({ gateways: { nmi, sezzle: true } })).toEqual(['nmi', 'sezzle']);
		expect(availableBalanceMethods({ gateways: { nmi: null, sezzle: true } })).toEqual(['sezzle']);
		expect(availableBalanceMethods({ gateways: { nmi: null, sezzle: false } })).toEqual([]);
		expect(availableBalanceMethods({ gateways: { nmi: { ...nmi, tokenizationKey: '' }, sezzle: false } })).toEqual([]);
		expect(availableBalanceMethods(null)).toEqual([]);
	});
});

describe('query helpers', () => {
	it('reads pay=balance and the receipt token', () => {
		expect(wantsBalancePay(new URLSearchParams('rt=abc&pay=balance'))).toBe(true);
		expect(wantsBalancePay(new URLSearchParams('rt=abc'))).toBe(false);
		expect(receiptTokenFrom(new URLSearchParams('rt=abc&pay=balance'))).toBe('abc');
		expect(receiptTokenFrom(new URLSearchParams('rt=%20'))).toBeUndefined();
		expect(receiptTokenFrom(new URLSearchParams(''))).toBeUndefined();
	});
});

describe('alreadyPaidCents', () => {
	it('is the total minus what is still due, never negative', () => {
		expect(alreadyPaidCents(5000, 1200)).toBe(3800);
		expect(alreadyPaidCents(5000, 0)).toBe(5000);
		expect(alreadyPaidCents(1000, 5000)).toBe(0);
		expect(alreadyPaidCents(5000, -10)).toBe(5000);
	});
});
