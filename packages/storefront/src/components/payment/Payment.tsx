import { component$, QRL, useSignal, useTask$, useVisibleTask$, Signal, $ } from '@qwik.dev/core';
import { PaymentService } from '~/services/PaymentService';
import { EligiblePaymentMethods } from '~/types';
import NMI from './NMI';
import Sezzle from './Sezzle';

interface PaymentProps {
 onForward$: QRL<(orderCode: string) => void>;
 onError$: QRL<(errorMessage: string) => void>;
 onProcessingChange$?: QRL<(isProcessing: boolean) => void>;
 triggerNMISignal: Signal<number>;
 triggerSezzleSignal: Signal<number>;
 selectedPaymentMethod?: Signal<string>;
 isDisabled?: boolean;
 hideButton?: boolean;
}

export default component$<PaymentProps>(({ onForward$, onError$, onProcessingChange$, triggerNMISignal: _triggerNMISignal, triggerSezzleSignal, selectedPaymentMethod: externalSelectedPaymentMethod, isDisabled, hideButton = false }) => {
	const paymentMethods = useSignal<EligiblePaymentMethods[]>();
	const methodsLoaded = useSignal<boolean>(false);
	const internalSelectedPaymentMethod = useSignal<string>('nmi');

	const selectedPaymentMethod = externalSelectedPaymentMethod || internalSelectedPaymentMethod;

	useVisibleTask$(async () => {
		try {
			const methods = await PaymentService.getEligiblePaymentMethods();
			if (methods && methods.length > 0) {
				paymentMethods.value = methods;
			}
		} catch (error) {
			console.error('[Payment] Error loading payment methods:', error);
		} finally {
			methodsLoaded.value = true;
		}
	});

	const handlePaymentMethodChange = $((method: string) => {
		selectedPaymentMethod.value = method;
	});

	// Fallback: if the fetch failed or returned empty, show both tabs
	// (current behaviour) rather than hiding payment entirely.
	const hasEligibleMethods = (paymentMethods.value?.length ?? 0) > 0;
	const nmiEligible = !hasEligibleMethods || paymentMethods.value!.some(m => m.code === 'nmi' && m.isEligible);
	const sezzleEligible = !hasEligibleMethods || paymentMethods.value!.some(m => m.code === 'sezzle' && m.isEligible);

	// Auto-switch selection if current selection becomes ineligible.
	// Runs inside useTask$ to avoid mutating signals during render.
	useTask$(({ track }) => {
		track(() => methodsLoaded.value);
		track(() => paymentMethods.value);
		if (!methodsLoaded.value) return;
		if (selectedPaymentMethod.value === 'nmi' && !nmiEligible && sezzleEligible) {
			selectedPaymentMethod.value = 'sezzle';
		} else if (selectedPaymentMethod.value === 'sezzle' && !sezzleEligible && nmiEligible) {
			selectedPaymentMethod.value = 'nmi';
		}
	});

	return (
		<div class={`flex flex-col ${isDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
			{/* Tab buttons */}
			<div class="flex border-b border-[rgba(184,115,51,0.15)] mb-4">
				{nmiEligible && (
					<button
						type="button"
						onClick$={() => handlePaymentMethodChange('nmi')}
						class={
							selectedPaymentMethod.value === 'nmi'
								? 'pb-2 mr-6 text-[11px] tracking-[0.1em] uppercase font-medium text-[#141210] border-b-2 border-[#8C6B3F] -mb-px cursor-pointer bg-transparent'
								: 'pb-2 mr-6 text-[11px] tracking-[0.1em] uppercase text-[rgba(0,0,0,0.35)] cursor-pointer bg-transparent border-b-2 border-transparent -mb-px'
						}
					>
						Credit / Debit Card
					</button>
				)}
				{sezzleEligible && (
					<button
						type="button"
						onClick$={() => handlePaymentMethodChange('sezzle')}
						class={
							selectedPaymentMethod.value === 'sezzle'
								? 'pb-2 text-[11px] tracking-[0.1em] uppercase font-medium text-[#141210] border-b-2 border-[#8C6B3F] -mb-px cursor-pointer bg-transparent'
								: 'pb-2 text-[11px] tracking-[0.1em] uppercase text-[rgba(0,0,0,0.35)] cursor-pointer bg-transparent border-b-2 border-transparent -mb-px'
						}
					>
						Pay in 4 · 0% Interest
					</button>
				)}
			</div>

			{/* Tab content */}
			<div class="w-full">
				{nmiEligible && selectedPaymentMethod.value === 'nmi' && (
					<div>
						<NMI
							isDisabled={isDisabled}
							onForward$={onForward$}
							onError$={onError$}
							onProcessingChange$={onProcessingChange$}
							hideButton={hideButton}
							triggerSignal={_triggerNMISignal}
						/>
					</div>
				)}

				{sezzleEligible && selectedPaymentMethod.value === 'sezzle' && (
					<div>
						<p class="text-sm text-[rgba(0,0,0,0.5)] py-3">
							Split your purchase into 4 interest-free payments with Sezzle.
						</p>
						<Sezzle
							isDisabled={isDisabled}
							onForward$={onForward$}
							onError$={onError$}
							onProcessingChange$={onProcessingChange$}
							hideButton={hideButton}
							triggerSignal={triggerSezzleSignal}
						/>
					</div>
				)}
			</div>
		</div>
	);
});
