import { component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
// S5: `pure` defers Stripe.js until loadStripe() runs (only when messaging options exist); the package root injects it
// on import, which loaded it on every checkout/PDP even with no Stripe gateway configured.
import { loadStripe } from '@stripe/stripe-js/pure';
import type { StripePaymentMethodMessagingElement } from '@stripe/stripe-js';
import type { PaymentMessagingOptions } from './payment-messaging';

/**
 * Pay-over-time messaging at the top of checkout: the card gateway's Payment Method Messaging Element. It names only the
 * installment methods enabled on the store's gateway account (the same ones its payment form offers), so nothing here
 * is hard-coded per brand. Client-only (Stripe.js is imperative); stays hidden until the element is ready and while
 * `options` is null (see payment-messaging.ts). Informational only: a load failure (Stripe.js or the element never
 * becoming ready) keeps it hidden and never blocks checkout. Also mounted on product pages (platform/widgets/PayLaterMessaging).
 */
export const CheckoutPaymentMessaging = component$<{ options: PaymentMessagingOptions | null; testId?: string; marginBottom?: string }>((props) => {
	const hostRef = useSignal<HTMLElement>();
	const ready = useSignal(false);
	const elementRef = useSignal<unknown>(null);

	// Mount once per gateway account (publishable key) and shopper country (#400: never left to the IP's country).
	useVisibleTask$(async ({ track, cleanup }) => {
		const key = track(() => props.options?.publishableKey ?? '');
		track(() => props.options?.countryCode);
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
			element = stripe.elements().create('paymentMethodMessaging', { amount: first.amount, currency: first.currency, countryCode: first.countryCode });
			element.on('ready', () => { if (!disposed) ready.value = true; });
			element.mount(host);
			elementRef.value = element as unknown;
		} catch (e) {
			console.warn('[Checkout] payment messaging failed to load:', e);
		}
	// document-ready, not the default intersection trigger: the wrapper is display:none until the element is ready, and a
	// display:none element never intersects, so a visible-triggered task would never mount it.
	}, { strategy: 'document-ready' });

	// Follow the charged total (shipping quote, coupons, server order total) without remounting.
	useVisibleTask$(({ track }) => {
		const amount = track(() => props.options?.amount ?? 0);
		const currency = track(() => props.options?.currency);
		const element = track(() => elementRef.value) as StripePaymentMethodMessagingElement | null;
		if (!element || !currency || amount <= 0) return;
		element.update({ amount, currency });
	}, { strategy: 'document-ready' });

	return (
		<div class="checkout-payment-messaging" data-testid={props.testId ?? 'checkout-payment-messaging'} style={{ display: props.options && ready.value ? 'block' : 'none', marginBottom: props.marginBottom ?? '16px' }}>
			<div ref={hostRef} />
		</div>
	);
});
