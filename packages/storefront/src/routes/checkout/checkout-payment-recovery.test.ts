import { describe, expect, it, vi } from 'vitest';
import { classifyResumePaymentError, recoverCheckoutPaymentError, RESUME_PAYMENT_RETRY_MESSAGE } from './checkout-payment-recovery';

const order = { code: 'ORD-A', receiptToken: 'rt_a' };
const reading = (state: string) => vi.fn(async () => ({ state, code: 'ORD-A' }));

describe('classifyResumePaymentError (payment failure inside the resume view)', () => {
	it('a decline on a still-payable order keeps the controls and carries a message to show', async () => {
		const read = reading('PendingPayment');
		await expect(classifyResumePaymentError(order, read)).resolves.toEqual({ kind: 'payable', message: RESUME_PAYMENT_RETRY_MESSAGE });
		expect(read).toHaveBeenCalledWith('ORD-A', 'rt_a');
	});

	it('an order cancelled between panel initialisation and payment removes the controls (cancelled recovery)', async () => {
		await expect(classifyResumePaymentError(order, reading('Cancelled'))).resolves.toEqual({ kind: 'cancelled' });
	});

	it('a payment that settled although the client call failed goes to confirmation', async () => {
		await expect(classifyResumePaymentError(order, reading('Paid'))).resolves.toEqual({ kind: 'settled', code: 'ORD-A', receiptToken: 'rt_a' });
		await expect(classifyResumePaymentError(order, reading('Shipped'))).resolves.toMatchObject({ kind: 'settled' });
	});

	it('an unknown state is a non-payable error', async () => {
		for (const state of ['Declined', 'AddingItems', 'SomethingNew']) {
			await expect(classifyResumePaymentError(order, reading(state))).resolves.toMatchObject({ kind: 'error' });
		}
	});

	it('an unreadable order is a non-payable error (a blind retry could double-pay)', async () => {
		const read = vi.fn(async () => {
			throw new Error('network down');
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(classifyResumePaymentError(order, read)).resolves.toMatchObject({ kind: 'error' });
	});
});

describe('an empty order read never throws out of the recovery', () => {
	it('classifyResumePaymentError: a reader that resolves null / undefined / a state-less body is an unresolved status', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const empty of [null, undefined, {}]) {
			const read = vi.fn(async () => empty as never);
			await expect(classifyResumePaymentError(order, read)).resolves.toMatchObject({ kind: 'error' });
		}
	});

	it('the real getOrder on HTTP 204 / JSON null yields the error outcome, and the form recovery still resets the form', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const empty of [() => new Response(null, { status: 204 }), () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } })]) {
			vi.resetModules();
			vi.stubGlobal('fetch', vi.fn(async () => empty()));
			const mod = await import('./checkout-payment-recovery');
			await expect(mod.classifyResumePaymentError(order)).resolves.toMatchObject({ kind: 'error', message: "We couldn't confirm your payment status. Please try again." });
			const signal = <T,>(value: T) => ({ value }) as { value: T };
			const navigate = vi.fn();
			const state = { error: null as string | null };
			const processing = signal(true);
			const modal = signal(true);
			await mod.recoverCheckoutPaymentError({ isOrderProcessing: processing as never, navigate, showProcessingModal: modal as never, state, order });
			expect(navigate).not.toHaveBeenCalled();
			expect(state.error).toBe('Please try a different card or payment method.');
			expect(processing.value).toBe(false);
			expect(modal.value).toBe(false);
			vi.unstubAllGlobals();
		}
	});
});

describe('recoverCheckoutPaymentError (superseded recovery)', () => {
	const signal = <T,>(value: T) => ({ value }) as { value: T };
	it('a result that arrives after the recovery was superseded changes nothing and does not navigate', async () => {
		let release!: (v: { state: string; code: string }) => void;
		vi.doMock('~/providers/shop/checkout/checkout', () => ({ getOrder: () => new Promise((r) => { release = r; }) }));
		vi.resetModules();
		const { recoverCheckoutPaymentError: recover } = await import('./checkout-payment-recovery');
		let current = true;
		const navigate = vi.fn();
		const state = { error: null as string | null };
		const processing = signal(true);
		const modal = signal(true);
		const run = recover({ isOrderProcessing: processing as never, navigate, showProcessingModal: modal as never, state, order: { code: 'ORD-A' }, isCurrent: () => current });
		current = false;
		release({ state: 'Paid', code: 'ORD-A' });
		await run;
		expect(navigate).not.toHaveBeenCalled();
		expect(state.error).toBeNull();
		expect(processing.value).toBe(true);
		vi.doUnmock('~/providers/shop/checkout/checkout');
		void recoverCheckoutPaymentError;
	});
});
