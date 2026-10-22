import { component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { loadStripe, type StripePaymentMethodMessagingElement } from '@stripe/stripe-js';
import type { PaymentMessagingOptions } from './payment-messaging';

/**
 * Pay-over-time messaging at the top of checkout: the card gateway's Payment Method Messaging Element. It names only the
 * installment methods enabled on the store's gateway account (the same ones its payment form offers), so nothing here
 * is hard-coded per brand. Client-only (Stripe.js is imperative); stays hidden until the element is ready and while
 * `options` is null (see payment-messaging.ts). Informational only: a load failure hides it and never blocks checkout.
 */
export const CheckoutPaymentMessaging = component$<{ options: PaymentMessagingOptions | null }>((props) => {
	const hostRef = useSignal<HTMLElement>();
	const ready = useSignal(false);
	const elementRef = useSignal<unknown>(null);

	// Mount once per gateway account (publishable key).
	useVisibleTask$(async ({ track, cleanup }) => {
		const key = track(() => props.options?.publishableKey ?? '');
		const host = track(() => hostRef.value);
		const first = props.options;
		if (!key || !host || !first) return;
		let disposed = false;
		let element: StripePaymentMethodMessagingElement | null = null;
		cleanup(() => {
			disposed = true;
			try { element?.destroy(); } catch { /* already destroyed */ }
			elementRef.value = null;
			ready.value = false;
		});
		try {
			const stripe = await loadStripe(key);
			if (disposed || !stripe) return;
			element = stripe.elements().create('paymentMethodMessaging', { amount: first.amount, currency: first.currency });
			element.on('ready', () => { if (!disposed) ready.value = true; });
			element.mount(host);
			elementRef.value = element as unknown;
		} catch (e) {
			console.warn('[Checkout] payment messaging failed to load:', e);
		}
	});

	// Follow the charged total (shipping quote, coupons, server order total) without remounting.
	useVisibleTask$(({ track }) => {
		const amount = track(() => props.options?.amount ?? 0);
		const currency = track(() => props.options?.currency);
		const element = track(() => elementRef.value) as StripePaymentMethodMessagingElement | null;
		if (!element || !currency || amount <= 0) return;
		element.update({ amount, currency });
	});

	return (
		<div class="checkout-payment-messaging" data-testid="checkout-payment-messaging" style={{ display: props.options && ready.value ? 'block' : 'none', marginBottom: '16px' }}>
			<div ref={hostRef} />
		</div>
	);
});
