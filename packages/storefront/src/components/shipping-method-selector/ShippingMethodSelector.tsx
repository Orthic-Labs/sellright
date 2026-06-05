import { component$, useStore, useTask$ } from '@qwik.dev/core';
import { ShippingService } from '~/services/ShippingService';
import { setOrderShippingMethodMutation } from '~/providers/shop/orders/order';
import { AppState, EligibleShippingMethods } from '~/types';
import { formatPrice } from '~/utils';
import CheckCircleIcon from '../icons/CheckCircleIcon';

type Props = {
	appState: AppState;
};

export default component$<Props>(({ appState }) => {

	const state = useStore<{ selectedMethodId: string; methods: EligibleShippingMethods[] }>({
		selectedMethodId: '',
		methods: [],
	});

	// T28: Shipping method selection → useTask$
	useTask$(async ({ track }) => {
		const countryCode = track(() => appState.shippingAddress?.countryCode);
		const subtotal = track(() => appState.activeOrder?.subTotalWithTax || 0);
		if (countryCode && subtotal > 0) {
			state.methods = await ShippingService.getEligibleShippingMethods(countryCode, subtotal);
			state.selectedMethodId = state.methods[0]?.id || '';
		}
	});

	useTask$(async ({ track }) => {
		const selected = track(() => state.selectedMethodId);
		if (selected) {
			appState.activeOrder = await setOrderShippingMethodMutation([selected]);
		}
	});

	return (
		<div>
			<label class="text-lg font-medium text-gray-900">{`Delivery method`}</label>
			<div class="mt-4 grid grid-cols-1 gap-y-6 sm:grid-cols-2 sm:gap-x-4">
				{state.methods.map((method) => (
					<div
						key={method.id}
						data-method-id={method.id}
						class={`relative bg-white border rounded-lg shadow-xs p-4 flex cursor-pointer focus:outline-hidden`}
						onClick$={(e) => {
						const el = (e.target as HTMLElement).closest('[data-method-id]') as HTMLElement | null;
						if (el?.dataset.methodId) state.selectedMethodId = el.dataset.methodId;
					}}
					>
						<span class="flex-1 flex">
							<span class="flex flex-col">
								<span class="block text-sm font-medium text-gray-900">{method.name}</span>
								<span class="mt-6 text-sm font-medium text-gray-900">
									{formatPrice(method.priceWithTax)}
								</span>
							</span>
						</span>
						{state.selectedMethodId === method.id && <CheckCircleIcon />}
						<span
							class={`border-2 ${
								state.selectedMethodId === method.id ? 'border-black' : ''
							} absolute -inset-px rounded-lg pointer-events-none`}
						></span>
					</div>
				))}
			</div>
		</div>
	);
});
