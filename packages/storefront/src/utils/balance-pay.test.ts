import { describe, expect, it } from 'vitest';
import { alreadyPaidCents, availableBalanceMethods, balancePageState, balanceReturnUrl, classifySettlePayment, classifySettleStatus, receiptTokenFrom, reconcileBalance, stripeReturnFrom, wantsBalancePay } from './balance-pay';

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
	it('lists configured methods in display order, Stripe first', () => {
		expect(availableBalanceMethods({ gateways: { nmi, sezzle: true } })).toEqual(['nmi', 'sezzle']);
		expect(availableBalanceMethods({ gateways: { nmi: null, sezzle: true } })).toEqual(['sezzle']);
		expect(availableBalanceMethods({ gateways: { nmi: null, sezzle: false } })).toEqual([]);
		expect(availableBalanceMethods({ gateways: { nmi: { ...nmi, tokenizationKey: '' }, sezzle: false } })).toEqual([]);
		expect(availableBalanceMethods(null)).toEqual([]);
	});
	it('offers Stripe on a Stripe-only store (configured + publishable key)', () => {
		expect(availableBalanceMethods({ stripeConfigured: true, stripePublishableKey: 'pk_test_1', gateways: { nmi: null, sezzle: false } })).toEqual(['stripe']);
		expect(availableBalanceMethods({ stripeConfigured: true, stripePublishableKey: 'pk_test_1', gateways: { nmi, sezzle: true } })).toEqual(['stripe', 'nmi', 'sezzle']);
	});
	it('hides Stripe when unconfigured or keyless', () => {
		expect(availableBalanceMethods({ stripeConfigured: false, stripePublishableKey: 'pk_test_1', gateways: { nmi: null, sezzle: false } })).toEqual([]);
		expect(availableBalanceMethods({ stripeConfigured: true, stripePublishableKey: ' ', gateways: { nmi: null, sezzle: false } })).toEqual([]);
		expect(availableBalanceMethods({ stripeConfigured: true, stripePublishableKey: null, gateways: { nmi: null, sezzle: false } })).toEqual([]);
	});
});

describe('Stripe return + reconcile', () => {
	const noSleep = async () => {};
	const live = () => new AbortController().signal;
	const statusOf = (e: unknown) => (e as { status?: number })?.status ?? null;
	it('builds the return URL and reads the intent Stripe appends', () => {
		expect(balanceReturnUrl('https://x.test', 'A 1', 'tok/1')).toBe('https://x.test/orders/A%201/?rt=tok%2F1&pay=balance');
		expect(stripeReturnFrom(new URLSearchParams('payment_intent=pi_1&redirect_status=succeeded'))).toEqual({ intentId: 'pi_1', failed: false });
		expect(stripeReturnFrom(new URLSearchParams('payment_intent=pi_1&redirect_status=failed'))).toEqual({ intentId: 'pi_1', failed: true });
		expect(stripeReturnFrom(new URLSearchParams('payment_intent=evil'))).toBeNull();
	});
	it('ends pending, not failed, when the balance has not cleared; a later round can clear', async () => {
		let due = 500;
		const args = { statusOf, sleep: noSleep, attempts: 2, settle: async () => {}, read: async () => due, signal: live() };
		expect(await reconcileBalance(args)).toBe('pending');
		due = 0;
		expect(await reconcileBalance(args)).toBe('cleared');
	});
	it('is unknown when nothing answers; failed only on 402/422', async () => {
		const e503 = Object.assign(new Error('x'), { status: 503 });
		expect(await reconcileBalance({ statusOf, sleep: noSleep, attempts: 2, settle: async () => { throw e503; }, read: async () => null, signal: live() })).toBe('unknown');
		const e402 = Object.assign(new Error('x'), { status: 402 });
		expect(await reconcileBalance({ statusOf, sleep: noSleep, settle: async () => { throw e402; }, read: async () => 500, signal: live() })).toBe('failed');
		expect(classifySettleStatus(409)).toBe('unknown');
	});
	it('typed /pay Declined is failed without polling (retry with a new intent)', async () => {
		let reads = 0;
		const out = await reconcileBalance({ statusOf, sleep: noSleep, settle: async () => 'Declined', read: async () => { reads++; return 500; }, signal: live() });
		expect(out).toBe('failed');
		expect(reads).toBe(0);
		expect(classifySettlePayment('Declined')).toBe('failed');
	});
	it('typed /pay Failed (amount verification after capture) stays unknown/pending, never failed', async () => {
		expect(classifySettlePayment('Failed')).toBe('unknown');
		expect(await reconcileBalance({ statusOf, sleep: noSleep, attempts: 2, settle: async () => 'Failed', read: async () => null, signal: live() })).toBe('unknown');
		expect(await reconcileBalance({ statusOf, sleep: noSleep, attempts: 2, settle: async () => 'Failed', read: async () => 500, signal: live() })).toBe('pending');
	});
	it('typed /pay Settled clears via reads; Pending stays pending', async () => {
		expect(await reconcileBalance({ statusOf, sleep: noSleep, settle: async () => 'Settled', read: async () => 0, signal: live() })).toBe('cleared');
		expect(await reconcileBalance({ statusOf, sleep: noSleep, attempts: 2, settle: async () => 'Pending', read: async () => 500, signal: live() })).toBe('pending');
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
