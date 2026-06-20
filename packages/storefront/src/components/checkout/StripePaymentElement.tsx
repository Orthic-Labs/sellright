import { $, component$, useSignal, useVisibleTask$, type QRL, type Signal } from '@qwik.dev/core';
import { loadStripe, type Stripe, type StripeElements } from '@stripe/stripe-js';

/**
 * Stripe Payment Element (checkout-migration, behind VITE_SR_CHECKOUT).
 *
 * loadStripe(publishableKey) → Elements(clientSecret) → mount the Payment
 * Element into a div → on `confirmTrigger` flip, stripe.confirmPayment({
 * return_url }). On success Stripe redirects to the confirmation page; on error
 * onError$ fires with the message (the order stays PendingPayment for retry).
 *
 * Stripe.js is imperative + browser-only, so all of this runs in a
 * useVisibleTask$ (never SSR). The element is fully client-rendered.
 */
export interface StripePaymentElementProps {
	publishableKey: string;
	clientSecret: string;
	returnUrl: string;
	/** Flip (increment) to trigger confirmPayment. */
	confirmTrigger: Signal<number>;
	onError$: QRL<(message: string) => void>;
	onProcessingChange$?: QRL<(processing: boolean) => void>;
}

export const StripePaymentElement = component$<StripePaymentElementProps>((props) => {
	const containerId = useSignal(`stripe-pe-${Math.random().toString(36).slice(2)}`);
	const ready = useSignal(false);

	// Hold the imperative Stripe handles across tasks (not serializable → noSerialize-free
	// by keeping them in module-task closures via signals holding `any`).
	const stripeRef = useSignal<unknown>(null);
	const elementsRef = useSignal<unknown>(null);

	// Mount: load Stripe + Elements + Payment Element.
	useVisibleTask$(async () => {
		try {
			const stripe: Stripe | null = await loadStripe(props.publishableKey);
			if (!stripe) {
				await props.onError$('Stripe failed to load.');
				return;
			}
			const elements: StripeElements = stripe.elements({ clientSecret: props.clientSecret });
			const paymentElement = elements.create('payment');
			paymentElement.mount(`#${containerId.value}`);
			stripeRef.value = stripe as unknown;
			elementsRef.value = elements as unknown;
			ready.value = true;
		} catch (e) {
			await props.onError$(e instanceof Error ? e.message : 'Stripe init failed.');
		}
	});

	// Confirm: when confirmTrigger flips, run confirmPayment.
	useVisibleTask$(async ({ track }) => {
		const t = track(() => props.confirmTrigger.value);
		if (!t || !ready.value) return;
		const stripe = stripeRef.value as Stripe | null;
		const elements = elementsRef.value as StripeElements | null;
		if (!stripe || !elements) {
			await props.onError$('Payment is not ready yet.');
			return;
		}
		await props.onProcessingChange$?.(true);
		const { error } = await stripe.confirmPayment({
			elements,
			confirmParams: { return_url: props.returnUrl },
		});
		// confirmPayment only RETURNS on error (success redirects to return_url).
		if (error) {
			await props.onProcessingChange$?.(false);
			await props.onError$(error.message || 'Payment could not be completed.');
		}
	});

	return (
		<div>
			<div id={containerId.value} />
			{!ready.value && (
				<div style="padding:12px 0;font-size:12px;color:rgba(100,85,65,0.5);">Loading secure payment…</div>
			)}
		</div>
	);
});

/** Helper for callers: a stable QRL to flip a confirm-trigger signal. */
export const triggerConfirm$ = $((sig: Signal<number>) => {
	sig.value = sig.value + 1;
});
