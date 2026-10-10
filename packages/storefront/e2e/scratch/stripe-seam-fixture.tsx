// A6 fixture route. NOT part of the product: scratch-layout.sh copies this file to
// src/routes/__stripe-seam-fixture/index.tsx of a SCRATCH tree only (base scratch, and again the Rotten legacy scratch
// so the same fixture runs against that tree's own @stripe/stripe-js). It exercises the installed `loadStripe` exactly
// the way Rotten's StripePaymentElement does (mode:'payment' elements, payment element, elements.submit(), then
// stripe.confirmPayment({elements, clientSecret, ...})), against an order the spec created. Query: ?code=&token=&pk=
import { component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { loadStripe } from '@stripe/stripe-js';

export default component$(() => {
	const state = useSignal('idle');
	const detail = useSignal('');

	useVisibleTask$(async ({ cleanup }) => {
		const q = new URLSearchParams(location.search);
		const code = q.get('code') ?? '';
		const token = q.get('token') ?? '';
		const pk = q.get('pk') ?? '';
		let destroyed = false;
		cleanup(() => { destroyed = true; });
		try {
			// 1. the API mints the intent for this order (amount from the order row)
			const res = await fetch(`/v1/shop/orders/${encodeURIComponent(code)}/payment-intent`, { method: 'POST', headers: { 'x-receipt-token': token } });
			if (!res.ok) throw new Error(`payment-intent ${res.status}`);
			const { clientSecret, intentId } = (await res.json()) as { clientSecret: string; intentId: string };
			// 2. Stripe.js
			const stripe = await loadStripe(pk);
			if (!stripe) throw new Error('loadStripe returned null');
			const elements = stripe.elements({ mode: 'payment', amount: 2500, currency: 'usd' });
			const element = elements.create('payment', { layout: 'tabs' });
			element.on('loaderror', () => { state.value = 'loaderror'; });
			element.on('change', (e: { complete?: boolean }) => { detail.value = e.complete ? 'complete' : 'incomplete'; });
			element.on('ready', () => { if (!destroyed) state.value = 'ready'; });
			element.mount('#stripe-seam-mount');
			// 3. the shopper's "Pay": submit, confirm, then the API verifies the intent server-side (/pay)
			(window as unknown as { __seamPay?: () => Promise<void> }).__seamPay = async () => {
				state.value = 'paying';
				const submitted = await elements.submit();
				if (submitted.error) { state.value = 'declined'; detail.value = submitted.error.message ?? ''; return; }
				const confirmed = await stripe.confirmPayment({ elements, clientSecret, confirmParams: { return_url: `${location.origin}/checkout/confirmation/${code}` }, redirect: 'if_required' });
				if (confirmed.error) { state.value = 'declined'; detail.value = confirmed.error.message ?? ''; return; }
				const pay = await fetch(`/v1/shop/orders/${encodeURIComponent(code)}/pay`, {
					method: 'POST', headers: { 'content-type': 'application/json', 'x-receipt-token': token, 'idempotency-key': crypto.randomUUID() },
					body: JSON.stringify({ method: 'stripe', token: { paymentIntentId: intentId } }),
				});
				const body = (await pay.json()) as { state?: string; payment?: string };
				state.value = pay.ok && body.state === 'Paid' ? 'paid' : 'not-paid';
				detail.value = JSON.stringify(body);
			};
		} catch (e) {
			state.value = 'error';
			detail.value = e instanceof Error ? e.message : String(e);
		}
	}, { strategy: 'document-ready' });

	return (
		<main>
			<div id="stripe-seam-mount" />
			<p data-testid="seam-state">{state.value}</p>
			<p data-testid="seam-detail">{detail.value}</p>
		</main>
	);
});
