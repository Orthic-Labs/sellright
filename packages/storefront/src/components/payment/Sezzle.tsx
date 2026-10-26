import { $, component$, useSignal, type QRL } from '@qwik.dev/core';
import { startGatewayPayment } from '~/providers/shop/checkout/checkout';
import { SellRightError } from '~/sellright/client';
import { INSTALLMENT_PROVIDER, providerLabel } from '~/platform/payments/labels';
import type { PayableOrder } from '~/components/checkout/payable-order';
import { formatPrice } from '~/utils/price-format';
import { INSTALLMENT_WHEN, installmentSchedule } from './installments';

/**
 * Generic installment-payment redirect (Sezzle). Starting the attempt mints
 * a hosted-checkout session (`checkoutUrl`) server-side; there is no token to
 * collect here — the button just starts the session and redirects. The
 * shopper returns to `/checkout/confirmation/{code}?paymentAttempt=...`
 * (see `session-input.ts`'s `completeUrl`), where the confirmation route
 * calls `verifyGatewayPayment` to reconcile the session.
 *
 * The panel above the button is the previous store's: the four-payment schedule, the no-interest line and the
 * redirect note. The provider is named through the label map (never typed here), as the brand lint requires.
 *
 * Each click that starts a session mints its own Idempotency-Key (a key reused across clicks would replay a failed
 * start forever); `isStarting` makes a double click the same single attempt.
 */
export interface SezzleProps {
	/** The order to pay; '' before it exists (then `ensureOrder$` supplies it on click). */
	code: string;
	receiptToken?: string;
	label?: string;
	/** What is charged, in cents: the schedule splits it into four payments (no schedule when absent or 0). */
	totalCents?: number;
	currency?: string;
	disabled?: boolean;
	/** The route's view generation when this component was rendered; every callback carries it so a stale mount is rejected. */
	mountGen?: number;
	onError$: QRL<(message: string, mountGen?: number) => void>;
	onProcessingChange$?: QRL<(processing: boolean, mountGen?: number) => void>;
	/** #372: the order to pay, created on the first click; null = stop. */
	ensureOrder$?: QRL<() => Promise<PayableOrder | null>>;
}

export const Sezzle = component$<SezzleProps>((props) => {
	const isStarting = useSignal(false);
	// This component's own mount id: captured once (the body re-runs on re-render, `useSignal` keeps the first value).
	const mountGen = useSignal(props.mountGen);

	const start$ = $(async () => {
		if (isStarting.value || props.disabled) return;
		isStarting.value = true;
		let code = props.code;
		let receiptToken = props.receiptToken;
		if (props.ensureOrder$) {
			const order = await props.ensureOrder$();
			if (!order) {
				isStarting.value = false;
				return;
			}
			code = order.code;
			receiptToken = order.receiptToken || undefined;
		}
		await props.onProcessingChange$?.(true, mountGen.value);
		try {
			const result = await startGatewayPayment(code, INSTALLMENT_PROVIDER, {
				idempotencyKey: crypto.randomUUID(),
				receiptToken,
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

	const provider = providerLabel(INSTALLMENT_PROVIDER);
	const schedule = props.totalCents && props.totalCents > 0 ? installmentSchedule(props.totalCents) : null;

	return (
		<div class="w-full border-0">
			<div class="rounded-md border border-black/10 bg-white/50 p-3" data-testid="installment-schedule">
				<p class="text-center text-[11px] leading-snug text-black/60">No interest. No fees if paid on time.</p>
				{schedule && (
					<ol aria-label="Payment schedule" class="grid grid-cols-4 gap-2 list-none m-0 p-0 mt-2">
						{INSTALLMENT_WHEN.map((when, index) => (
							<li key={when} class={`rounded border py-1.5 text-center ${index === 0 ? 'border-[var(--color-accent)] bg-white' : 'border-black/10'}`}>
								<div class={`text-base sm:text-lg tabular-nums ${index === 0 ? 'font-semibold text-[var(--color-accent)]' : 'font-medium text-[var(--color-ink)]'}`}>{formatPrice(schedule[index], props.currency)}</div>
								<div class={`text-[11px] ${index === 0 ? 'font-medium text-[var(--color-accent)]' : 'text-black/55'}`}>{when}</div>
							</li>
						))}
					</ol>
				)}
			</div>
			<p class="mt-2 mb-3 text-center text-[11px] leading-snug text-black/60">You'll be redirected to {provider} to complete payment.</p>
			<button
				type="button"
				class="checkout-cta"
				disabled={props.disabled || isStarting.value}
				onClick$={start$}
			>
				{isStarting.value ? 'Redirecting…' : (props.label ?? `Continue with ${provider}`)}
			</button>
		</div>
	);
});

export default Sezzle;
