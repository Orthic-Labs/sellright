// The real Sezzle component, rendered (SSR, resumption, client click), reporting to the checkout route's real callbacks
// (payment-callbacks.ts) against a deferred gateway response. Covers the mount id the component captured at mount.
import { $, component$ } from '@qwik.dev/core';
import { ssrRenderToDom, trigger } from '@qwik.dev/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPaymentProcessingChange } from '~/components/checkout/payment-callbacks';
import { bumpView } from '~/components/checkout/view-generation';
import { Sezzle } from './Sezzle';

vi.mock('~/providers/shop/checkout/checkout', () => ({
	startGatewayPayment: (...args: unknown[]) => {
		const g = (globalThis as unknown as { __sz: Sink }).__sz;
		g.starts.push(args);
		return g.response;
	},
}));

interface Sink {
	view: { gen: number; failed: boolean };
	state: { loading: boolean };
	flags: { processingModal: { value: boolean }; orderProcessing: { value: boolean } };
	errors: Array<{ message: string; mountGen?: number }>;
	starts: unknown[][];
	response: Promise<unknown>;
	release: (v: unknown) => void;
	accepted: boolean[];
}
const g = globalThis as unknown as { __sz: Sink };
const reset = () => {
	let release!: (v: unknown) => void;
	const response = new Promise<unknown>((r) => { release = r; });
	g.__sz = {
		view: { gen: 0, failed: false },
		state: { loading: false },
		flags: { processingModal: { value: false }, orderProcessing: { value: false } },
		errors: [],
		starts: [],
		response,
		release,
		accepted: [],
	};
};
reset();
afterEach(reset);

const settle = async (until: () => boolean) => {
	for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
};

const Host = component$(() => {
	const onProcessingChange$ = $((processing: boolean, mountGen?: number) => {
		g.__sz.accepted.push(applyPaymentProcessingChange(g.__sz, processing, mountGen));
	});
	const onError$ = $((message: string, mountGen?: number) => {
		g.__sz.errors.push({ message, mountGen });
	});
	// the page renders Sezzle with the view's current generation (paymentInit.gen)
	return <Sezzle code="ORD-1" mountGen={g.__sz.view.gen} onError$={onError$} onProcessingChange$={onProcessingChange$} />;
});

describe('Sezzle reports with the mount id it was rendered with', () => {
	it('the current mount locks the view while the session starts, reports its error with its id, and releases the lock', async () => {
		const { document } = await ssrRenderToDom(<Host />, {});
		const click = trigger(document.body, 'button', 'click');
		await settle(() => g.__sz.starts.length === 1);
		expect(g.__sz.accepted).toEqual([true]); // lock accepted: this mount is the current view
		expect(g.__sz.state.loading).toBe(true);
		expect(g.__sz.view.gen).toBe(0); // starting the session does not replace the view
		g.__sz.release({}); // the gateway answers without a checkoutUrl
		await click;
		await settle(() => g.__sz.errors.length === 1 && g.__sz.accepted.length === 2);
		expect(g.__sz.errors).toEqual([{ message: 'Could not start the installment checkout. Please try again.', mountGen: 0 }]);
		expect(g.__sz.accepted).toEqual([true, true]); // release is always accepted
		expect(g.__sz.state.loading).toBe(false);
	});

	it('a Sezzle left behind by a method switch cannot lock the current view', async () => {
		const { document } = await ssrRenderToDom(<Host />, {});
		bumpView(g.__sz.view); // the shopper switched method; this mount is now stale
		g.__sz.release({});
		await trigger(document.body, 'button', 'click');
		await settle(() => g.__sz.accepted.length >= 1);
		expect(g.__sz.accepted[0]).toBe(false);
		expect(g.__sz.state.loading).toBe(false);
	});
});
