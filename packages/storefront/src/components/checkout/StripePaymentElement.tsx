import { $, component$, useSignal, useVisibleTask$, type QRL, type Signal } from '@qwik.dev/core';
import { paymentElementOptions } from './payment-element-options';
// S5: the `pure` entry injects Stripe.js only when loadStripe() is called; the package root injects it as soon as this
// module is imported (it was loaded on every checkout, including stores with no Stripe gateway).
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe, StripeElements, StripePaymentElement as StripePaymentElementHandle, StripePaymentElementOptions } from '@stripe/stripe-js';
import type { PayableOrder } from './payable-order';

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
 *
 * #372 deferred mode: with no `clientSecret` the element mounts before the order exists (`mode: 'payment'` with the
 * shown amount + currency, kept in sync). PAY then runs elements.submit() (validation, wallet sheets), asks the page for
 * the order (`ensureOrder$`: created on the first PAY, with its PaymentIntent) and confirms against its client secret.
 */
export interface StripePaymentElementProps {
	publishableKey: string;
	/** The order's PaymentIntent secret; '' mounts in deferred mode (needs `amount`, `currency`, `ensureOrder$`). */
	clientSecret: string;
	returnUrl: string;
	/** Deferred mode: the amount shown to the shopper, in minor units. */
	amount?: number;
	/** Deferred mode: ISO currency of `amount`. */
	currency?: string;
	/** Deferred mode: the order to confirm, created on the first PAY; null = stop without charging. */
	ensureOrder$?: QRL<() => Promise<PayableOrder | null>>;
	/** Deferred mode: Stripe's own validation message (incomplete card, invalid ZIP): shown as is, before any order exists. */
	onValidationError$?: QRL<(message: string, mountGen?: number) => void>;
	/** Flip (increment) to trigger confirmPayment. */
	confirmTrigger: Signal<number>;
	/** The route's view generation when this component was rendered; every callback carries it so a stale mount is rejected. */
	mountGen?: number;
	onError$: QRL<(message: string, mountGen?: number) => void>;
	/** The Payment Element could not be LOADED/mounted (SDK, network) — distinct from a declined payment; falls back to `onError$`. */
	onInitError$?: QRL<(message: string, mountGen?: number) => void>;
	onProcessingChange$?: QRL<(processing: boolean, mountGen?: number) => void>;
	/** #400: billing country/ZIP defaults (see billingDefaultValues); applied at mount and whenever they change. */
	billingDefaults?: StripePaymentElementOptions['defaultValues'];
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
	const paymentElementRef = useSignal<unknown>(null);

	// Set when the component is removed (e.g. the shopper switched payment method while Stripe was still loading).
	// Every async callback below checks it: a late failure from a dead component must not report into the shared
	// payment-init state and take the healthy replacement's controls away.
	const disposed = useSignal(false);

	// Mount: load Stripe + Elements + Payment Element.
	useVisibleTask$(async ({ cleanup }) => {
		let paymentElement: StripePaymentElementHandle | null = null;
		cleanup(() => {
			disposed.value = true;
			paymentElementRef.value = null;
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
			const elements: StripeElements = props.clientSecret
				? stripe.elements({ clientSecret: props.clientSecret })
				: stripe.elements({ mode: 'payment', amount: Math.max(1, Math.round(props.amount ?? 0)), currency: (props.currency || 'usd').toLowerCase() });
			const element = elements.create('payment', paymentElementOptions(props.billingDefaults));
			paymentElement = element;
			paymentElementRef.value = element as unknown;
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

	// #400: billing defaults follow the checkout address (the shopper changing the shipping country after the form mounted).
	useVisibleTask$(({ track }) => {
		const key = track(() => JSON.stringify(props.billingDefaults ?? null));
		const element = track(() => paymentElementRef.value) as StripePaymentElementHandle | null;
		if (!element || disposed.value || key === 'null') return;
		element.update({ defaultValues: props.billingDefaults });
	});

	// Deferred mode: the element's amount follows the total shown (shipping, coupons, the order's own total once it exists).
	useVisibleTask$(({ track }) => {
		const amount = track(() => props.amount);
		const elements = track(() => elementsRef.value) as StripeElements | null;
		if (props.clientSecret || !elements || disposed.value || !amount) return;
		elements.update({ amount: Math.max(1, Math.round(amount)) });
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
		let deferredSecret = '';
		let returnUrl = props.returnUrl;
		if (!props.clientSecret) {
			// Deferred: validate the details first (nothing is created for an incomplete form), then the order.
			const submitted = await elements.submit();
			if (disposed.value) return;
			if (submitted.error) {
				const message = submitted.error.message || 'Check your payment details.';
				await (props.onValidationError$ ?? props.onError$)(message, mountGen.value);
				return;
			}
			const order = props.ensureOrder$ ? await props.ensureOrder$() : null;
			if (!order || !order.clientSecret || disposed.value) return;
			deferredSecret = order.clientSecret;
			returnUrl = order.returnUrl;
		}
		await props.onProcessingChange$?.(true, mountGen.value);
		// An element created from the intent's secret confirms with the elements alone; a deferred one names the intent.
		const { error } = deferredSecret
			? await stripe.confirmPayment({ elements, clientSecret: deferredSecret, confirmParams: { return_url: returnUrl } })
			: await stripe.confirmPayment({ elements, confirmParams: { return_url: returnUrl } });
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
