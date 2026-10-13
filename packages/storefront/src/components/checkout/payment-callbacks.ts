import { acceptsMount, type ViewGeneration } from './view-generation';

/**
 * What the checkout route does when a mounted payment component reports back. Each callback carries the mount id the
 * component captured at mount; a component that is no longer the current view says nothing about the current one.
 */
export interface PaymentCallbackDeps {
	view: ViewGeneration & { failed: boolean };
	state: { loading: boolean };
	flags: { processingModal: { value: boolean }; orderProcessing: { value: boolean } };
}

/** The component failed to LOAD (not a decline): show the retry that remounts it. Returns false when rejected as stale. */
export const applyPaymentInitError = (deps: PaymentCallbackDeps, mountGen?: number): boolean => {
	if (!acceptsMount(deps.view, mountGen)) return false;
	deps.flags.processingModal.value = false;
	deps.flags.orderProcessing.value = false;
	deps.state.loading = false;
	deps.view.failed = true;
	return true;
};

/** A stale component may not LOCK the current view; releasing a lock is always accepted. */
export const applyPaymentProcessingChange = (deps: PaymentCallbackDeps, isProcessing: boolean, mountGen?: number): boolean => {
	if (isProcessing && !acceptsMount(deps.view, mountGen)) return false;
	deps.state.loading = isProcessing;
	deps.flags.orderProcessing.value = isProcessing;
	return true;
};
