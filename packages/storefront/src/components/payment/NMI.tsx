import { component$, useSignal, useVisibleTask$, type QRL, type Signal } from '@qwik.dev/core';
import { loadCollectJs, prepareCardTokenization } from '~/services/NmiCollect';
import { startGatewayPayment } from '~/providers/shop/checkout/checkout';
import type { GatewayAttempt } from '~/sellright/types/checkout';
import { SellRightError } from '~/sellright/client';

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
	onError$: QRL<(message: string) => void>;
	onProcessingChange$?: QRL<(processing: boolean) => void>;
	onSuccess$: QRL<(result: GatewayAttempt) => void>;
}

export const NMI = component$<NMIProps>((props) => {
	const idPrefix = useSignal(`nmi-${Math.random().toString(36).slice(2)}`);
	const ready = useSignal(false);
	const collectRef = useSignal<unknown>(null);
	const getTokenRef = useSignal<unknown>(null);
	const submitting = useSignal(false);

	useVisibleTask$(async () => {
		try {
			const collect = await loadCollectJs(props.tokenizationKey, props.mode, undefined, props.environment);
			collectRef.value = collect as unknown;
			const getToken = prepareCardTokenization(
				collect,
				{
					ccnumber: `#${idPrefix.value}-number`,
					ccexp: `#${idPrefix.value}-exp`,
					cvv: `#${idPrefix.value}-cvv`,
				},
				() => { ready.value = true; },
			);
			getTokenRef.value = getToken as unknown;
		} catch (e) {
			await props.onError$(e instanceof Error ? e.message : 'Card payment failed to load.');
		}
	});

	useVisibleTask$(async ({ track }) => {
		const t = track(() => props.confirmTrigger.value);
		if (!t || !ready.value) return;
		if (submitting.value) return; // double click: the attempt already in flight is this one
		const getToken = getTokenRef.value as (() => Promise<string>) | null;
		if (!getToken) {
			await props.onError$('Payment is not ready yet.');
			return;
		}
		submitting.value = true;
		await props.onProcessingChange$?.(true);
		try {
			const token = await getToken();
			const result = await startGatewayPayment(props.code, 'nmi', {
				token,
				idempotencyKey: crypto.randomUUID(), // a new card submit is a new attempt
				receiptToken: props.receiptToken,
			});
			if (result.status === 'settled') {
				await props.onSuccess$(result);
			} else {
				await props.onError$('The card was declined. Please try a different card.');
			}
		} catch (e) {
			const message = e instanceof SellRightError ? e.message : (e instanceof Error ? e.message : 'Card payment failed.');
			await props.onError$(message);
		} finally {
			submitting.value = false;
			await props.onProcessingChange$?.(false);
		}
	});

	return (
		<div class="nmi-card-form" style="display:flex;flex-direction:column;gap:12px;">
			<div>
				<label for={`${idPrefix.value}-number`} class="sr-only">Card number</label>
				<div id={`${idPrefix.value}-number`} class="nmi-field" style="height:42px;border:1px solid rgba(100,85,65,0.2);border-radius:4px;padding:0 10px;display:flex;align-items:center;" />
			</div>
			<div style="display:flex;gap:12px;">
				<div style="flex:1;">
					<label for={`${idPrefix.value}-exp`} class="sr-only">Expiration</label>
					<div id={`${idPrefix.value}-exp`} class="nmi-field" style="height:42px;border:1px solid rgba(100,85,65,0.2);border-radius:4px;padding:0 10px;display:flex;align-items:center;" />
				</div>
				<div style="flex:1;">
					<label for={`${idPrefix.value}-cvv`} class="sr-only">Security code</label>
					<div id={`${idPrefix.value}-cvv`} class="nmi-field" style="height:42px;border:1px solid rgba(100,85,65,0.2);border-radius:4px;padding:0 10px;display:flex;align-items:center;" />
				</div>
			</div>
		</div>
	);
});

export default NMI;
