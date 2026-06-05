import { $, Signal, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import type { QRL } from '@qwik.dev/core';
import { processSezzlePayment } from '~/providers/shop/checkout/checkout';
import { useCheckoutValidationActions } from '~/contexts/CheckoutValidationContext';

interface SezzleProps {
	isDisabled?: boolean;
	hideButton?: boolean;
	onForward$: QRL<(orderCode: string) => void>;
	onError$: QRL<(errorMessage: string) => void>;
	onProcessingChange$?: QRL<(isProcessing: boolean) => void>;
	triggerSignal: Signal<number>; // Incremented by parent to trigger submission
}

export default component$<SezzleProps>(({ isDisabled, hideButton: _hideButton = false, onForward$: _onForward$, onError$, onProcessingChange$, triggerSignal }) => {
	const isProcessing = useSignal(false);
	const error = useSignal('');
	const validationActions = useCheckoutValidationActions();

	// For Sezzle, we don't need form validation since it's a redirect-based payment
	// But we still need to update the checkout validation context
	const updatePaymentValidationContext = $(() => {
		// Sezzle is always "valid" since there's no form to validate
		validationActions.updatePaymentValidation(
			true, // Always valid
			{}, // No errors
			true // Always considered "touched" since user selected Sezzle
		);
	});

	// Update validation context when component mounts
	useVisibleTask$(() => {
		updatePaymentValidationContext();
	});

	// Core submission logic for Sezzle payment
	const submitPaymentForm = $(async () => {
		error.value = '';

		if (isProcessing.value) {
			// console.log('Sezzle payment already processing, ignoring duplicate submission.');
			return;
		}

		let redirectInitiated = false;
		try {
			isProcessing.value = true;

			// Notify parent about processing state change
			if (onProcessingChange$) {
				await onProcessingChange$(true);
			}

			// Process the Sezzle payment (this will create a session and return checkout URL)
			const paymentResult = await processSezzlePayment();

			// Check if we have a valid order object (handle both explicit __typename and duck typing)
			const isOrder = paymentResult?.__typename === 'Order' || (paymentResult?.id && paymentResult?.code && paymentResult?.state);

			if (isOrder) {
				// For Sezzle, we need to check if there's a declined payment with a redirect URL
				const payments = paymentResult.payments || [];

				const sezzlePayment = payments.find((p: any) => p.method === 'sezzle');

				if (!sezzlePayment) {
					console.warn('[Sezzle] Sezzle payment object not found in order response, checking for checkoutUrl in order metadata as fallback...');
					// If for some reason payments didn't return, check if it's in the top level (some custom plugins do this)
					if ((paymentResult as any).metadata?.checkoutUrl) {
						redirectInitiated = true;
						window.location.href = (paymentResult as any).metadata.checkoutUrl;
						return;
					}
				}

				// Check for checkout URL in public metadata first
				if (sezzlePayment?.metadata?.public?.checkoutUrl) {
					redirectInitiated = true;
					window.location.href = sezzlePayment.metadata.public.checkoutUrl;
					return;
				}

				// Fallback: check direct metadata
				if (sezzlePayment?.metadata?.checkoutUrl) {
					redirectInitiated = true;
					window.location.href = sezzlePayment.metadata.checkoutUrl;
					return;
				}

				// If we get here, something went wrong
				console.error('[Sezzle] No checkout URL found in payment metadata:', sezzlePayment?.metadata);
				throw new Error('Sezzle checkout URL not found. Please try again.');
			} else {
				console.error('[Sezzle] Payment failed with result:', paymentResult);
				let errorMsg = 'Sezzle payment initialization failed. Please try again.';
				if (paymentResult && typeof paymentResult === 'object' && 'errorMessage' in paymentResult) {
					errorMsg = paymentResult.errorMessage as string;
				}
				throw new Error(errorMsg);
			}
		} catch (err) {
			console.error('[Sezzle] Payment error:', err);
			error.value = err instanceof Error ? err.message : 'An unknown error occurred during Sezzle payment processing.';
			// Call the error callback with the error message
			await onError$(error.value);
		} finally {
			// 🚨 CRITICAL FIX: If we initiated a redirect, do NOT set isProcessing to false
			// This prevents the UI from re-rendering while the page is unloading,
			// which can trigger secondary effects like failed mutations on a non-active order.
			if (!redirectInitiated) {
				isProcessing.value = false;
				// Notify parent about processing state change
				if (onProcessingChange$) {
					await onProcessingChange$(false);
				}
			}
		}
	});

	// Watch for trigger signal from parent component
	useVisibleTask$(({track}) => {
		track(() => triggerSignal.value);
		// Ensure we only trigger if the signal has a positive value (indicating a new attempt)
		// and we are not already processing a payment.
		if (triggerSignal.value > 0) {
			if (!isProcessing.value) {
				// console.log('[Sezzle] Trigger signal received, initiating payment.');
				submitPaymentForm();
			} else {
				// console.log('[Sezzle] Trigger signal received but payment already in progress, ignoring.');
			}
		}
	});

	return (
		<div class={`w-full ${isDisabled ? 'opacity-50 pointer-events-none' : ''} border-0`}>
			{/* Sezzle payment breakdown */}
			<div class="flex flex-col items-center gap-3 py-4">
				{/* eslint-disable-next-line qwik/jsx-img */}
				<img src="/sezzle-color.svg" alt="Sezzle" width="100" height="28" />
				<div class="flex items-center gap-3 text-[13px] text-[rgba(0,0,0,0.55)]">
					<div class="flex items-center gap-6">
						<div class="text-center"><div class="text-[15px] font-medium text-[#141210]">25%</div><div class="text-[10px] text-[rgba(0,0,0,0.4)]">Today</div></div>
						<div class="text-[rgba(0,0,0,0.15)]">→</div>
						<div class="text-center"><div class="text-[15px] font-medium text-[#141210]">25%</div><div class="text-[10px] text-[rgba(0,0,0,0.4)]">Week 2</div></div>
						<div class="text-[rgba(0,0,0,0.15)]">→</div>
						<div class="text-center"><div class="text-[15px] font-medium text-[#141210]">25%</div><div class="text-[10px] text-[rgba(0,0,0,0.4)]">Week 4</div></div>
						<div class="text-[rgba(0,0,0,0.15)]">→</div>
						<div class="text-center"><div class="text-[15px] font-medium text-[#141210]">25%</div><div class="text-[10px] text-[rgba(0,0,0,0.4)]">Week 6</div></div>
					</div>
				</div>
				<p class="text-[11px] text-[rgba(0,0,0,0.4)] text-center">No interest. No fees if paid on time. You'll be redirected to Sezzle to complete payment.</p>
			</div>

			{/* Error Display - Keep for functionality */}
			{error.value && (
				<div class="mt-4 p-3 bg-red-50 border border-red-200 rounded-md">
					<div class="flex items-center">
						<div class="flex-shrink-0">
							<svg class="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
								<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
							</svg>
						</div>
						<div class="ml-3">
							<p class="text-sm text-red-800">{error.value}</p>
						</div>
					</div>
				</div>
			)}
		</div>
	);
});
