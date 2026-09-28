import type { QRL, Signal } from '@qwik.dev/core';

/**
 * Address "submission" for the native checkout: there is no incremental
 * legacy order to sync addresses onto step by step. Shipping/billing
 * address + customer info live in `appState` as plain local state and are
 * only sent to the server ONCE, inside the single POST /v1/shop/checkout
 * call `placeOrder` (routes/checkout/index.tsx) makes. This function's job
 * is purely local: confirm the form is in a submittable shape and flip the
 * "addresses submitted" signals the payment step gates on.
 */
type SubmitCheckoutAddressesOptions = {
	appState: any;
	checkoutAddressState: any;
	useDifferentBilling: Signal<boolean>;
	isLoading: Signal<boolean>;
	addressSubmissionInProgress: Signal<boolean>;
	addressSubmissionComplete: Signal<boolean>;
	error: Signal<string>;
	hasProceeded: Signal<boolean>;
	onAddressesSubmitted$?: QRL<() => void>;
};

export async function submitCheckoutAddresses(options: SubmitCheckoutAddressesOptions): Promise<void> {
	const {
		appState,
		checkoutAddressState,
		useDifferentBilling,
		isLoading,
		addressSubmissionInProgress,
		addressSubmissionComplete,
		error,
		hasProceeded,
		onAddressesSubmitted$,
	} = options;

	try {
		addressSubmissionInProgress.value = true;
		isLoading.value = true;
		checkoutAddressState.addressSubmissionInProgress = true;

		// Sync customer data to appState before submission since the automatic
		// sync was removed.
		appState.customer = {
			firstName: appState.customer?.firstName || '',
			lastName: appState.customer?.lastName || '',
			emailAddress: appState.customer?.emailAddress || '',
			phoneNumber: appState.shippingAddress?.phoneNumber || '',
			id: appState.customer?.id || '',
			title: appState.customer?.title || '',
		};

		if (!appState.shippingAddress?.countryCode) {
			throw new Error('Country code is required for shipping address');
		}
		if (useDifferentBilling.value && !appState.billingAddress?.countryCode) {
			throw new Error('Country code is required for billing address');
		}

		if (onAddressesSubmitted$) {
			await onAddressesSubmitted$();
		}

		addressSubmissionComplete.value = true;
		checkoutAddressState.addressSubmissionComplete = true;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'An error occurred';
		hasProceeded.value = false; // Allow retry on error
	} finally {
		isLoading.value = false;
		addressSubmissionInProgress.value = false;
		checkoutAddressState.addressSubmissionInProgress = false;
	}
}
