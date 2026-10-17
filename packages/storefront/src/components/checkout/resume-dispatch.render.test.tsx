import { $, component$, useSignal, useStore } from '@qwik.dev/core';
import { ssrRenderToDom, trigger } from '@qwik.dev/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaymentMethod, ResumeView } from '~/hooks/useCheckout';
import type { ShopConfig } from '~/sellright/types/checkout';
import { CheckoutResumePanel } from './CheckoutResumePanel';
import { beginResumeFlow } from './resume-flow';
import type { ResumeQueue } from './resume-selection';
import type { PaymentInitState } from './PaymentInitRetry';

interface Sink {
	gate: Promise<void>;
	release: () => void;
	failDispatch: boolean;
	dispatches: PaymentMethod[];
	requests: Array<PaymentMethod | null>;
	retries: number;
}
const g = globalThis as unknown as { __resumeDispatch: Sink };
const reset = () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	g.__resumeDispatch = { gate, release, failDispatch: false, dispatches: [], requests: [], retries: 0 };
};
reset();
afterEach(reset);
const settle = async (until: () => boolean) => {
	for (let i = 0; i < 200 && !until(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

const Host = component$(() => {
	const paymentMethod = useSignal<PaymentMethod>('stripe');
	const paymentInit = useStore<PaymentInitState>({ gen: 0, key: 0, failed: false });
	const queue = useStore<ResumeQueue<PaymentMethod>>({ busy: false, pending: null, epoch: 0 });
	const state = useStore({ loading: false });
	const srState = useStore({
		resume: 'payable' as ResumeView, resumeLines: [], code: 'ORD-1', receiptToken: 'rt1',
		clientSecret: '', grandTotal: 1200, error: null as string | null, paymentError: null,
	});
	const shopConfig = useSignal<ShopConfig | null>({ stripeConfigured: true, gateways: { sezzle: {} } } as unknown as ShopConfig);
	const stripePublishableKey = useSignal('');
	const stripeConfirmTrigger = useSignal(0);
	const gatewayConfirmTrigger = useSignal(0);
	const resume = $(async (method: PaymentMethod) => {
		await beginResumeFlow({
			queue, view: paymentInit, srState, state,
			selectedMethod: () => paymentMethod.value,
			token: () => 'cart-token',
			ensureShopConfig: async () => shopConfig.value!,
			resumeConverted: async (_token, selected) => {
				g.__resumeDispatch.requests.push(selected);
				srState.resume = 'payable';
				return 'payable';
			},
			navigate: () => { throw new Error('unexpected navigation'); },
		}, method);
	});
	const onResumeMethod$ = $(async (method: PaymentMethod) => {
		g.__resumeDispatch.dispatches.push(method);
		// The route module has not loaded yet: its queue and global loading state cannot protect this gap.
		await g.__resumeDispatch.gate;
		if (g.__resumeDispatch.failDispatch) throw new Error('private lazy-loader detail');
		await resume(method);
	});
	const onResumeRetry$ = $(async () => {
		g.__resumeDispatch.retries++;
		await resume(paymentMethod.value);
	});
	const ignore = $(() => {});
	return <CheckoutResumePanel
		gatewayConfirmTrigger={gatewayConfirmTrigger} onGatewaySuccess$={ignore}
		onPaymentInitError$={ignore} onPaymentError$={ignore} onPaymentProcessingChange$={ignore}
		onResumeMethod$={onResumeMethod$} onResumeRetry$={onResumeRetry$} onStartNewCart$={ignore}
		paymentInit={paymentInit} paymentMethod={paymentMethod} shopConfig={shopConfig}
		srState={srState} state={state} stripeConfirmTrigger={stripeConfirmTrigger}
		stripePublishableKey={stripePublishableKey}
	/>;
});

const stripe = '[role="radio"]:nth-child(1)';
const sezzle = '[role="radio"]:nth-child(2)';

describe('resume method dispatch through the real panel', () => {
	it('locks before the deferred route callback runs, then initializes only the accepted selection', async () => {
		const { document } = await ssrRenderToDom(<Host />, {});
		const first = trigger(document.body, sezzle, 'click');
		await settle(() => g.__resumeDispatch.dispatches.length === 1);
		expect(g.__resumeDispatch.requests).toEqual([]);
		await settle(() => Array.from(document.querySelectorAll('[role="radio"]')).every((el) => el.hasAttribute('disabled')));
		expect(document.querySelector(sezzle)?.getAttribute('aria-checked')).toBe('true');
		expect(Array.from(document.querySelectorAll('[role="radio"]')).every((el) => el.hasAttribute('disabled'))).toBe(true);
		expect(document.body.textContent).toContain('Preparing payment...');
		expect(Array.from(document.querySelectorAll('button')).some((el) => /^(PAY|Continue)/.test(el.textContent?.trim() || ''))).toBe(false);
		const second = trigger(document.body, stripe, 'click');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(g.__resumeDispatch.dispatches).toEqual(['sezzle']);
		g.__resumeDispatch.release();
		await Promise.all([first, second]);
		await settle(() => !document.querySelector(sezzle)?.hasAttribute('disabled'));
		expect(g.__resumeDispatch.requests).toEqual(['sezzle']);
		expect(document.querySelector(sezzle)?.getAttribute('aria-checked')).toBe('true');
		expect(document.querySelector(sezzle)?.hasAttribute('disabled')).toBe(false);
		// A choice after the accepted switch completes is admitted and initializes its own method.
		await trigger(document.body, stripe, 'click');
		expect(g.__resumeDispatch.requests).toEqual(['sezzle', 'stripe']);
		expect(document.querySelector(stripe)?.getAttribute('aria-checked')).toBe('true');
	});

	it('a deferred dispatch failure shows the existing retryable error and retry initializes the accepted method', async () => {
		g.__resumeDispatch.failDispatch = true;
		const { document } = await ssrRenderToDom(<Host />, {});
		const first = trigger(document.body, sezzle, 'click');
		await settle(() => g.__resumeDispatch.dispatches.length === 1);
		g.__resumeDispatch.release();
		await first;
		await settle(() => document.querySelector('[role="alert"]') !== null);
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("We couldn't load your payment options. Please try again.");
		expect(document.body.textContent).not.toContain('private lazy-loader detail');
		expect(g.__resumeDispatch.requests).toEqual([]);
		await trigger(document.body, '[role="alert"] button', 'click');
		await settle(() => document.querySelector(sezzle) !== null);
		expect(g.__resumeDispatch.retries).toBe(1);
		expect(g.__resumeDispatch.requests).toEqual(['sezzle']);
		expect(document.querySelector(sezzle)?.getAttribute('aria-checked')).toBe('true');
		expect(document.querySelector(sezzle)?.hasAttribute('disabled')).toBe(false);
	});
});
