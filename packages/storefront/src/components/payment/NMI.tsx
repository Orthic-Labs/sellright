import { component$, useSignal, useVisibleTask$, type QRL, type Signal } from '@qwik.dev/core';
import { loadCollectJs, prepareCardTokenization } from '~/services/NmiCollect';
import { startGatewayPayment } from '~/providers/shop/checkout/checkout';
import type { GatewayAttempt } from '~/sellright/types/checkout';
import { SellRightError } from '~/sellright/client';
import { nextConfirm } from './confirm-trigger';

/**
 * Generic card-gateway payment (NMI via Collect.js). Same imperative,
 * browser-only shape as `StripePaymentElement`: hosted iframes replace the
 * raw card inputs (Collect.js never lets a PAN reach this app), tokenize on
 * `confirmTrigger`, then charge via the native gateway-payment API.
 *
 * One Idempotency-Key per PAY submit (per tokenized card): the API replays a known key, so a key shared across
 * submits would make every PAY after a decline return the same decline and the shopper could never pay with
 * another card. A second trigger while a submit is still in flight (double click) is the SAME attempt and is
 * dropped, so one click's key is never used by two requests.
 */
export interface NMIProps {
	code: string;
	tokenizationKey: string;
	mode: 'test' | 'live';
	environment: 'sandbox' | 'production';
	receiptToken?: string;
	/** Flip (increment) to trigger tokenization + charge. */
	confirmTrigger: Signal<number>;
	/** The route's view generation when this component was rendered; every callback carries it so a stale mount is rejected. */
	mountGen?: number;
	onError$: QRL<(message: string, mountGen?: number) => void>;
	/** Collect.js could not be LOADED/mounted — distinct from a declined card; falls back to `onError$`. */
	onInitError$?: QRL<(message: string, mountGen?: number) => void>;
	onProcessingChange$?: QRL<(processing: boolean, mountGen?: number) => void>;
	onSuccess$: QRL<(result: GatewayAttempt) => void>;
}

export const NMI = component$<NMIProps>((props) => {
	const idPrefix = useSignal(`nmi-${Math.random().toString(36).slice(2)}`);
	const ready = useSignal(false);
	// This component's own mount id: captured once (the body re-runs on re-render, `useSignal` keeps the first value).
	const mountGen = useSignal(props.mountGen);
	const collectRef = useSignal<unknown>(null);
	const getTokenRef = useSignal<unknown>(null);
	const submitting = useSignal(false);
	// Baseline = the parent's signal at mount: it survives payment-method switches, so a stale confirm must not replay.
	const handledTrigger = useSignal(props.confirmTrigger.value);

	// Set when the component is removed (payment method switched while Collect.js was still loading). Every async
	// callback checks it: a late load/timeout failure from a dead component must not report into the shared
	// payment-init state, and a late "fields ready" must not touch a gone view.
	const disposed = useSignal(false);

	useVisibleTask$(async ({ cleanup }) => {
		cleanup(() => { disposed.value = true; });
		const reportInitError = async (message: string) => {
			if (disposed.value) return;
			await (props.onInitError$ ?? props.onError$)(message, mountGen.value);
		};
		try {
			const collect = await loadCollectJs(props.tokenizationKey, props.mode, undefined, props.environment);
			if (disposed.value) return;
			collectRef.value = collect as unknown;
			const getToken = prepareCardTokenization(
				collect,
				{
					ccnumber: `#${idPrefix.value}-number`,
					ccexp: `#${idPrefix.value}-exp`,
					cvv: `#${idPrefix.value}-cvv`,
				},
				() => { if (!disposed.value) ready.value = true; },
				(message) => { void reportInitError(message); },
			);
			getTokenRef.value = getToken as unknown;
		} catch (e) {
			await reportInitError(e instanceof Error ? e.message : 'Card payment failed to load.');
		}
	}, { strategy: 'document-ready' }); // mount Collect.js as soon as the form renders, not on first intersection/interaction

	useVisibleTask$(async ({ track }) => {
		const t = track(() => props.confirmTrigger.value);
		// A confirm that arrives before the fields are ready is held, not dropped: it runs once they are.
		const isReady = track(() => ready.value);
		if (disposed.value) return;
		const decision = nextConfirm(t, isReady, handledTrigger.value);
		if (!decision.run) return;
		handledTrigger.value = decision.baseline;
		if (submitting.value) return; // double click: the attempt already in flight is this one
		const getToken = getTokenRef.value as (() => Promise<string>) | null;
		if (!getToken) {
			await props.onError$('Payment is not ready yet.', mountGen.value);
			return;
		}
		submitting.value = true;
		await props.onProcessingChange$?.(true, mountGen.value);
		try {
			const token = await getToken();
			if (disposed.value) return; // the component is gone: no charge on behalf of a removed view
			const result = await startGatewayPayment(props.code, 'nmi', {
				token,
				idempotencyKey: crypto.randomUUID(), // a new card submit is a new attempt
				receiptToken: props.receiptToken,
			});
			if (result.status === 'settled') {
				// The charge happened: the success must always be reported, even if the view is gone.
				await props.onSuccess$(result);
			} else if (!disposed.value) {
				await props.onError$('The card was declined. Please try a different card.', mountGen.value);
			}
		} catch (e) {
			if (disposed.value) return;
			const message = e instanceof SellRightError ? e.message : (e instanceof Error ? e.message : 'Card payment failed.');
			await props.onError$(message, mountGen.value);
		} finally {
			submitting.value = false;
			if (!disposed.value) await props.onProcessingChange$?.(false, mountGen.value);
		}
	});

	return (
		<div class="nmi-card-form" style="display:flex;flex-direction:column;gap:12px;">
			<div>
				<span aria-hidden="true" class="nmi-label" style="display:block;font-size:12px;margin-bottom:4px;color:var(--color-ink-soft,#6b6359);">Card number</span>
				<div id={`${idPrefix.value}-number`} class="nmi-field" style="height:42px;border:1px solid rgba(100,85,65,0.2);border-radius:4px;padding:0 10px;display:flex;align-items:center;" />
			</div>
			<div style="display:flex;gap:12px;">
				<div style="flex:1;">
					<span aria-hidden="true" class="nmi-label" style="display:block;font-size:12px;margin-bottom:4px;color:var(--color-ink-soft,#6b6359);">Expiration</span>
					<div id={`${idPrefix.value}-exp`} class="nmi-field" style="height:42px;border:1px solid rgba(100,85,65,0.2);border-radius:4px;padding:0 10px;display:flex;align-items:center;" />
				</div>
				<div style="flex:1;">
					<span aria-hidden="true" class="nmi-label" style="display:block;font-size:12px;margin-bottom:4px;color:var(--color-ink-soft,#6b6359);">Security code</span>
					<div id={`${idPrefix.value}-cvv`} class="nmi-field" style="height:42px;border:1px solid rgba(100,85,65,0.2);border-radius:4px;padding:0 10px;display:flex;align-items:center;" />
				</div>
			</div>
		</div>
	);
});

export default NMI;
