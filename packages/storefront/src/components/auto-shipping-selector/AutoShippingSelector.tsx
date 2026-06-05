import { component$, useOnDocument, useSignal, useStore, useTask$, $ } from '@qwik.dev/core';
import { getEligibleShippingMethodsCached } from '~/providers/shop/checkout/checkout';
import { setOrderShippingMethodMutation, setOrderShippingAddressMutation } from '~/providers/shop/orders/order';
import { AppState, EligibleShippingMethods, Order } from '~/types';
import { CreateAddressInput } from '~/generated/graphql-shop';
import { formatPrice } from '~/utils';


type Props = {
	appState: AppState;
};

export default component$<Props>(({ appState }) => {
	const currencyCode = appState.activeOrder?.currencyCode || 'USD';
	const state = useStore<{ 
		selectedMethod: EligibleShippingMethods | null; 
		methods: EligibleShippingMethods[];
		isLoading: boolean;
		error: string | null;
		lastCheckedCountry: string;
	}>({
		selectedMethod: null,
		methods: [],
		isLoading: false,
		error: null,
		lastCheckedCountry: '',
	});

	// Signal to track when we should query shipping methods
	const shouldQueryShipping = useSignal(false);

	// T27: Initial load on qinit
	useOnDocument('qinit', $(async () => {
		if (appState.shippingAddress.countryCode && appState.activeOrder?.subTotalWithTax) {
			shouldQueryShipping.value = true;
		}
	}));

	// T27: Watch country changes → useTask$
	useTask$(({ track }) => {
		const currentCountry = track(() => appState.shippingAddress.countryCode);
		const subtotal = track(() => appState.activeOrder?.subTotalWithTax);
		if (currentCountry && subtotal && (
			currentCountry !== state.lastCheckedCountry ||
			shouldQueryShipping.value
		)) {
			shouldQueryShipping.value = true;
		}
	});

	// T27: Execute shipping query when triggered → useTask$
	useTask$(async ({ track }) => {
		const shouldQuery = track(() => shouldQueryShipping.value);

		if (!shouldQuery) return;
		if (!appState.shippingAddress.countryCode) return;
		
		// Skip if we've already checked this country and subtotal combination
		if (state.lastCheckedCountry === appState.shippingAddress.countryCode && 
			!state.isLoading && state.methods.length > 0) {
			console.log(`🔄 Using cached shipping methods for ${appState.shippingAddress.countryCode}`);
			shouldQueryShipping.value = false;
			return;
		}

		console.log(`🚀 Querying shipping methods for country: ${appState.shippingAddress.countryCode}, subtotal: ${appState.activeOrder?.subTotalWithTax}`);

		state.isLoading = true;
		state.error = null;
		shouldQueryShipping.value = false;

		try {
			// Skip shipping mutations if no active order
			if (!appState.activeOrder) {
				console.log('🛒 No active order: Skipping shipping mutations, will calculate on Place Order');
				state.methods = []; // Clear methods since we can't calculate without order
				state.selectedMethod = null;
				state.lastCheckedCountry = appState.shippingAddress.countryCode;
				return;
			}

			// Prepare shipping address input
			const shippingAddressInput: CreateAddressInput = {
				fullName: appState.shippingAddress.fullName || '',
				company: appState.shippingAddress.company || '',
				// Use a placeholder if streetLine1 is missing, so we can fetch shipping rates early
				streetLine1: appState.shippingAddress.streetLine1 || 'TEMPORARY_PLACEHOLDER',
				streetLine2: appState.shippingAddress.streetLine2 || '',
				city: appState.shippingAddress.city || '',
				province: appState.shippingAddress.province || '',
				postalCode: appState.shippingAddress.postalCode || '',
				countryCode: appState.shippingAddress.countryCode, // countryCode is required by CreateAddressInput
				phoneNumber: appState.shippingAddress.phoneNumber || '',
			};

			// Start both API calls in parallel
			const addressPromise = setOrderShippingAddressMutation(shippingAddressInput);
			
			// Wait for address update to complete
			const orderResult = await addressPromise;

			if (orderResult && orderResult.__typename === 'Order') {
				// Update appState.activeOrder with all properties from orderResult
				appState.activeOrder = { ...appState.activeOrder, ...orderResult } as Order;
				console.log('✅ Shipping address set on order');
				
				// Now get eligible shipping methods
				const methods = await getEligibleShippingMethodsCached(
					appState.shippingAddress.countryCode,
					appState.activeOrder?.subTotalWithTax || 0
				);
				state.methods = methods;
				state.lastCheckedCountry = appState.shippingAddress.countryCode;
				
				console.log(`📦 Found ${methods.length} shipping methods:`, methods.map((m: any) => `${m.name} - ${formatPrice(m.priceWithTax, currencyCode)}`));
				
				// Auto-select the first (and ideally only) available method
				if (methods.length > 0) {
					const methodToSelect = methods[0];
					state.selectedMethod = methodToSelect;
					
					// Automatically set this shipping method on the order
					try {
						console.log(`✅ Auto-selecting shipping method: ${methodToSelect.name}`);
						const updatedOrder = await setOrderShippingMethodMutation([methodToSelect.id]);
						if (updatedOrder) {
							appState.activeOrder = updatedOrder;
							console.log(`💰 Shipping cost added: ${formatPrice(methodToSelect.priceWithTax, currencyCode)}`);
						}
					} catch (shippingError) {
						console.error('Failed to set shipping method:', shippingError);
						state.error = 'Failed to apply shipping method. Please try again.';
					}
				} else {
					state.selectedMethod = null;
					state.error = 'No shipping methods available for your location and order total.';
					console.warn(`⚠️ No shipping methods found for ${appState.shippingAddress.countryCode} with subtotal ${appState.activeOrder?.subTotalWithTax}`);
				}
			} else {
				console.error('Failed to set shipping address on order, mutation returned:', orderResult);
				state.error = (orderResult as any)?.message || 'Failed to update shipping address. Please check your address details.';
			}
		} catch (error: any) {
			console.error('Failed to set shipping address or fetch shipping methods:', error);
			state.error = error.message || 'Failed to load shipping options. Please try again.';
			state.methods = [];
			state.selectedMethod = null;
		} finally {
			state.isLoading = false;
		}
	});

	// Remove the entire shipping method UI section, as there is always only one option and it is auto-selected.
	return null;
});
