import { $, component$, useSignal, type QRL } from '@qwik.dev/core';
import { startGatewayPayment } from '~/providers/shop/checkout/checkout';
import { SellRightError } from '~/sellright/client';
import { INSTALLMENT_PROVIDER } from '~/platform/payments/labels';

/**
 * Generic installment-payment redirect (Sezzle). Starting the attempt mints
 * a hosted-checkout session (`checkoutUrl`) server-side; there is no token to
 * collect here — the button just starts the session and redirects. The
 * shopper returns to `/checkout/confirmation/{code}?paymentAttempt=...`
 * (see `session-input.ts`'s `completeUrl`), where the confirmation route
 * calls `verifyGatewayPayment` to reconcile the session.
 *
 * Each click that starts a session mints its own Idempotency-Key (a key reused across clicks would replay a failed
 * start forever); `isStarting` makes a double click the same single attempt.
 */
export interface SezzleProps {
	code: string;
	receiptToken?: string;
	label?: string;
	disabled?: boolean;
	/** The route's view generation when this component was rendered; every callback carries it so a stale mount is rejected. */
	mountGen?: number;
	onError$: QRL<(message: string, mountGen?: number) => void>;
	onProcessingChange$?: QRL<(processing: boolean, mountGen?: number) => void>;
}

export const Sezzle = component$<SezzleProps>((props) => {
	const isStarting = useSignal(false);
	// This component's own mount id: captured once (the body re-runs on re-render, `useSignal` keeps the first value).
	const mountGen = useSignal(props.mountGen);

	const start$ = $(async () => {
		if (isStarting.value || props.disabled) return;
		isStarting.value = true;
		await props.onProcessingChange$?.(true, mountGen.value);
		try {
			const result = await startGatewayPayment(props.code, INSTALLMENT_PROVIDER, {
				idempotencyKey: crypto.randomUUID(),
				receiptToken: props.receiptToken,
			});
			if (result.checkoutUrl) {
				window.location.href = result.checkoutUrl;
				return; // navigating away — leave isStarting true
			}
			await props.onError$('Could not start the installment checkout. Please try again.', mountGen.value);
		} catch (e) {
			const message = e instanceof SellRightError ? e.message : (e instanceof Error ? e.message : 'Could not start the installment checkout.');
			await props.onError$(message, mountGen.value);
		} finally {
			isStarting.value = false;
			await props.onProcessingChange$?.(false, mountGen.value);
		}
	});

	return (
		<button
			type="button"
			class="checkout-cta"
			disabled={props.disabled || isStarting.value}
			onClick$={start$}
		>
			{isStarting.value ? 'Redirecting…' : (props.label ?? 'Pay in installments')}
		</button>
	);
});

export default Sezzle;
