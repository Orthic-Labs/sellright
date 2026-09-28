import { $, component$, useSignal, type QRL } from '@qwik.dev/core';
import { startGatewayPayment } from '~/providers/shop/checkout/checkout';
import { SellRightError } from '~/sellright/client';

/**
 * Generic installment-payment redirect (Sezzle). Starting the attempt mints
 * a hosted-checkout session (`checkoutUrl`) server-side; there is no token to
 * collect here — the button just starts the session and redirects. The
 * shopper returns to `/checkout/confirmation/{code}?paymentAttempt=...`
 * (see `session-input.ts`'s `completeUrl`), where the confirmation route
 * calls `verifyGatewayPayment` to reconcile the session.
 */
export interface SezzleProps {
	code: string;
	idempotencyKey: string;
	receiptToken?: string;
	label?: string;
	disabled?: boolean;
	onError$: QRL<(message: string) => void>;
	onProcessingChange$?: QRL<(processing: boolean) => void>;
}

export const Sezzle = component$<SezzleProps>((props) => {
	const isStarting = useSignal(false);

	const start$ = $(async () => {
		if (isStarting.value || props.disabled) return;
		isStarting.value = true;
		await props.onProcessingChange$?.(true);
		try {
			const result = await startGatewayPayment(props.code, 'sezzle', {
				idempotencyKey: props.idempotencyKey,
				receiptToken: props.receiptToken,
			});
			if (result.checkoutUrl) {
				window.location.href = result.checkoutUrl;
				return; // navigating away — leave isStarting true
			}
			await props.onError$('Could not start the installment checkout. Please try again.');
		} catch (e) {
			const message = e instanceof SellRightError ? e.message : (e instanceof Error ? e.message : 'Could not start the installment checkout.');
			await props.onError$(message);
		} finally {
			isStarting.value = false;
			await props.onProcessingChange$?.(false);
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
