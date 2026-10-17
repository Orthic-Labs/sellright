import { $, component$, useSignal, useVisibleTask$, type QRL, type Signal } from '@qwik.dev/core';
import { loadStripe, type Stripe, type StripeElements, type StripePaymentElement as StripePaymentElementHandle } from '@stripe/stripe-js';

/**
 * Stripe Payment Element — the only card tender this storefront wires up.
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
	/** The route's view generation when this component was rendered; every callback carries it so a stale mount is rejected. */
	mountGen?: number;
	onError$: QRL<(message: string, mountGen?: number) => void>;
	/** The Payment Element could not be LOADED/mounted (SDK, network) — distinct from a declined payment; falls back to `onError$`. */
	onInitError$?: QRL<(message: string, mountGen?: number) => void>;
	onProcessingChange$?: QRL<(processing: boolean, mountGen?: number) => void>;
}

export const StripePaymentElement = component$<StripePaymentElementProps>((props) => {
	const containerId = useSignal(`stripe-pe-${Math.random().toString(36).slice(2)}`);
	const ready = useSignal(false);
	// This component's own mount id: captured once (the body re-runs on re-render, `useSignal` keeps the first value).
	const mountGen = useSignal(props.mountGen);

	// Hold the imperative Stripe handles across tasks (not serializable → noSerialize-free
	// by keeping them in module-task closures via signals holding `any`).
	const stripeRef = useSignal<unknown>(null);
	const elementsRef = useSignal<unknown>(null);

	// Set when the component is removed (e.g. the shopper switched payment method while Stripe was still loading).
	// Every async callback below checks it: a late failure from a dead component must not report into the shared
	// payment-init state and take the healthy replacement's controls away.
	const disposed = useSignal(false);

	// Mount: load Stripe + Elements + Payment Element.
	useVisibleTask$(async ({ cleanup }) => {
		let paymentElement: StripePaymentElementHandle | null = null;
		cleanup(() => {
			disposed.value = true;
			try { paymentElement?.destroy(); } catch { /* already destroyed */ }
		});
		const reportInitError = async (message: string) => {
			if (disposed.value) return;
			await (props.onInitError$ ?? props.onError$)(message, mountGen.value);
		};
		try {
			const stripe: Stripe | null = await loadStripe(props.publishableKey);
			if (disposed.value) return;
			if (!stripe) {
				await reportInitError('Stripe failed to load.');
				return;
			}
			const elements: StripeElements = stripe.elements({ clientSecret: props.clientSecret });
			const element = elements.create('payment', { layout: 'tabs' });
			paymentElement = element;
			// Loading failures after mount arrive asynchronously as `loaderror`; readiness is Stripe's `ready`, not the mount call.
			element.on('loaderror', (event) => {
				if (disposed.value) return;
				ready.value = false;
				element.destroy();
				void reportInitError(event.error?.message || 'Stripe payment form failed to load.');
			});
			element.on('ready', () => { if (!disposed.value) ready.value = true; });
			element.mount(`#${containerId.value}`);
			stripeRef.value = stripe as unknown;
			elementsRef.value = elements as unknown;
		} catch (e) {
			await reportInitError(e instanceof Error ? e.message : 'Stripe init failed.');
		}
	});

	// Confirm: when confirmTrigger flips, run confirmPayment.
	useVisibleTask$(async ({ track }) => {
		const t = track(() => props.confirmTrigger.value);
		if (!t || !ready.value || disposed.value) return;
		const stripe = stripeRef.value as Stripe | null;
		const elements = elementsRef.value as StripeElements | null;
		if (!stripe || !elements) {
			await props.onError$('Payment is not ready yet.', mountGen.value);
			return;
		}
		await props.onProcessingChange$?.(true, mountGen.value);
		const { error } = await stripe.confirmPayment({
			elements,
			confirmParams: { return_url: props.returnUrl },
		});
		// A removed component's result is not the current view's: the order status is re-read by whoever owns the page.
		if (disposed.value) return;
		// confirmPayment only RETURNS on error (success redirects to return_url).
		if (error) {
			// The controls stay locked through the error handler (it starts the recovery); only then are they released.
			try {
				await props.onError$(error.message || 'Payment could not be completed.', mountGen.value);
			} finally {
				if (!disposed.value) await props.onProcessingChange$?.(false, mountGen.value);
			}
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
