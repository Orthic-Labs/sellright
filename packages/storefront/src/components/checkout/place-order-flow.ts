import { shouldRecoverExistingOrder } from '~/hooks/checkout-stage';
import type { CheckoutPhase, PaymentMethod } from '~/hooks/useCheckout';
import type { ShopConfig } from '~/sellright/types/checkout';

/**
 * PLACE ORDER, from the validated form to the payment view, as the checkout route runs it. Extracted so tests can drive
 * the same code with deferred provider responses. It NEVER bumps the view generation: only a view replacement may, and
 * the order → payment sequence is not one. The route keeps validation, the form build and the catch/finally.
 */
export interface PlaceOrderFlowDeps<F> {
	srState: { convertedCart: boolean; phase: CheckoutPhase; code: string; receiptToken: string; stockConflict: boolean; error: string | null };
	state: { error: string | null };
	flags: { processingModal: { value: boolean }; orderProcessing: { value: boolean }; totalConfirmed: { value: boolean } };
	selectedMethod: () => PaymentMethod;
	/** Cents on screen right now: what the shopper agreed to. */
	shownCents: () => number;
	ensureShopConfig: () => Promise<ShopConfig>;
	placeOrder: (form: F, method: PaymentMethod | null, shownCents: number) => Promise<CheckoutPhase>;
	beginResume: () => Promise<void>;
	/** Live cart re-read after a stock conflict. */
	refreshStock: () => Promise<unknown>;
	navigate: (path: string) => unknown;
	hasCartToken: () => boolean;
	onPaying: () => void;
}

/** Resolves when the order was handled; throws the message the route shows when checkout failed. `current` is the view check captured at entry. */
export const submitOrderFlow = async <F>(deps: PlaceOrderFlowDeps<F>, form: F, current: () => boolean): Promise<void> => {
	const { srState, state, flags } = deps;
	flags.totalConfirmed.value = false;
	// When shop-config says the store has no gateway at all, don't mint a doomed Stripe PaymentIntent. Place the order
	// unpaid and land on 'paying', where the panel renders its explicit "no payment method configured" state.
	// No order exists yet: a config that cannot be read stops here instead of placing an order whose payment method is
	// unknown (a null config used to read as "configured").
	let cfg: ShopConfig;
	try {
		cfg = await deps.ensureShopConfig();
	} catch {
		throw new Error("We couldn't load your payment options. Please try again.");
	}
	if (!current()) return;
	const anyGatewayConfigured = !!cfg.stripeConfigured || !!cfg.gateways?.nmi || !!cfg.gateways?.sezzle;
	// The total on screen right now is what the shopper agreed to; the order comes back server-priced and the PAY step
	// gates on any difference.
	const phase = await deps.placeOrder(form, anyGatewayConfigured ? deps.selectedMethod() : null, deps.shownCents());
	// The page was left (or the view replaced) while the order request ran: nothing is shown or navigated here. The
	// order exists server-side and is picked up by the resume view on the next visit.
	if (!current()) return;
	if (srState.convertedCart) {
		// Another tab (or an earlier attempt) already turned this cart into an order: nothing was POSTed and the token
		// is kept. Show that order instead of the form.
		flags.processingModal.value = false;
		flags.orderProcessing.value = false;
		await deps.beginResume();
		return;
	}
	if (phase === 'paid') {
		flags.processingModal.value = false;
		flags.orderProcessing.value = false;
		const rt = srState.receiptToken ? `?rt=${encodeURIComponent(srState.receiptToken)}` : '';
		deps.navigate(`/checkout/confirmation/${srState.code}${rt}`);
		return;
	}
	if (phase === 'paying') {
		flags.processingModal.value = false;
		flags.orderProcessing.value = false;
		state.error = null;
		deps.onPaying();
		return;
	}
	if (shouldRecoverExistingOrder({ phase: srState.phase, orderCode: srState.code, convertedCart: srState.convertedCart }) && deps.hasCartToken()) {
		// The order was created but its payment initialisation (or zero-due settlement) failed: it is a real unpaid
		// order, so show it through the resume view with a retry instead of the form.
		flags.processingModal.value = false;
		flags.orderProcessing.value = false;
		await deps.beginResume();
		return;
	}
	if (srState.stockConflict) {
		// Someone else took the stock between this shopper's cart and PLACE ORDER: re-read the live cart so the line
		// stops saying "Only N left" and shows its real (sold-out) state. Live read — nothing is cached.
		await deps.refreshStock();
		if (!current()) return;
	}
	throw new Error(srState.error || 'Checkout failed. Please try again.');
};
