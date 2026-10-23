import { $, useStore } from '@qwik.dev/core';
import {
	getOrder as srGetOrder,
	isOutOfStockConflict,
	placeOrder as srPlaceOrder,
	createPaymentIntent as srCreatePI,
	settleZeroDueOrder as srSettleZeroDue,
	QuoteChangedError,
	type CheckoutQuote,
	type CheckoutForm,
} from '~/providers/shop/checkout/checkout';
import { CartService, ConvertedCartError } from '~/services/CartService';
import { decideCheckoutStage, decideResumeStage, EMPTY_ORDER_STATE } from './checkout-stage';
import { settleZeroDueProven } from './zero-due';
import { PreSubmitStockError, refreshStockBeforeSubmit } from './pre-submit-stock';

/**
 * Native checkout flow — single state machine, single backend. There is no
 * flag and no legacy fallback: every checkout on this storefront goes
 * through POST /v1/shop/checkout.
 *
 *   idle → placing (POST /checkout) → either
 *     - paid    (grandTotal 0, or the server already settled it — e.g. a
 *                gift card / loyalty points covered the whole total), or
 *     - paying  (non-zero total, still PendingPayment) — the caller mounts
 *                whichever payment method the shopper picked:
 *                'stripe' -> PaymentIntent client_secret + Payment Element
 *                'nmi'/'sezzle' -> no client_secret; the NMI/Sezzle
 *                components call the gateway-payment API directly
 *                null -> the store has no gateway configured at all; the
 *                order stays PendingPayment and the panel renders the
 *                explicit "no payment method configured" state
 *   → confirming (redirect to /checkout/confirmation/{code}?rt=… — Stripe's
 *     own redirect, or the NMI/Sezzle component navigating there itself)
 *   any step → error (recoverable — the order stays PendingPayment for retry)
 */
export type CheckoutPhase = 'idle' | 'placing' | 'paid' | 'paying' | 'error';
export type PaymentMethod = 'stripe' | 'nmi' | 'sezzle';
/** What the page shows while resuming the ORIGINAL order of a converted cart ('none' = a normal checkout). */
export type ResumeView = 'none' | 'loading' | 'payable' | 'settled' | 'cancelled' | 'error';
/** What `resumeConverted` reports: a view, or 'superseded' when the page's view generation changed mid-lookup (nothing was written). */
export type ResumeOutcome = ResumeView | 'superseded';

/**
 * Payment initialisation shared by a new order and a resumed one: the Stripe card path mints the PaymentIntent for
 * the order and returns its client_secret; NMI/Sezzle need nothing up front (their components call the gateway API
 * themselves), so they return ''.
 */
const initPayment = async (code: string, receiptToken: string, method: PaymentMethod | null, expectedAmount?: number): Promise<string> => {
	if (method !== 'stripe') return '';
	const pi = await srCreatePI(code, receiptToken || undefined, expectedAmount);
	if (!pi.clientSecret) throw new Error('Could not start the payment.');
	return pi.clientSecret;
};

const settleZeroDue = (code: string, receiptToken: string): Promise<boolean> =>
	settleZeroDueProven(code, receiptToken, { settle: srSettleZeroDue, readOrder: srGetOrder });

export const useCheckout = () => {
	const checkoutState = useStore({
		isLoading: false,
		error: null as string | null,
	});

	const state = useStore({
		phase: 'idle' as CheckoutPhase,
		code: '' as string,
		receiptToken: '' as string,
		clientSecret: '' as string,
		grandTotal: 0,
		/** Cents the shopper saw on the page when they pressed PLACE ORDER (0 = no total was shown) — the changed-total gate compares the order's grandTotal against it. */
		shownTotal: 0,
		/** The last PLACE ORDER was refused (pre-submit live read found a line unavailable, or 409 OUT_OF_STOCK) — the caller must re-read live stock for the cart. */
		stockConflict: false,
		quoteChange: null as { quote: CheckoutQuote; quoteHash: string } | null,
		method: null as PaymentMethod | null,
		error: null as string | null,
		/** Resume of a converted cart's original order — its own view, never behind the shipping/customer form gates. */
		resume: 'none' as ResumeView,
		/** Set when PLACE ORDER found the cart already converted: the page must switch to resume. */
		convertedCart: false,
		/** Best-effort line summary of the order being resumed (empty when the read failed). */
		resumeLines: [] as { name: string; quantity: number }[],
		/** A payment attempt on the resumed order failed but the order is still payable (decline, bad card). */
		paymentError: null as string | null,
	});

	/** Forget the previous order completely (code, receipt token, client secret, phase, method, totals, resume view): the cart behind it is gone or replaced. */
	const resetOrder = $(() => {
		Object.assign(state, { ...EMPTY_ORDER_STATE, resumeLines: [], quoteChange: null });
	});

	/**
	 * Create the order, then resolve either the zero-due short-circuit OR the
	 * requested payment method. `method` decides what "paying" needs from the
	 * caller: a Stripe PaymentIntent (minted here) or nothing at all (NMI/
	 * Sezzle components own their own API calls). Returns the resulting phase
	 * so the caller can mount the right payment UI ('paying') or navigate
	 * straight to confirmation ('paid').
	 */
	const placeOrder = $(async (form: CheckoutForm, method: PaymentMethod | null = 'stripe', shownTotalCents = 0, expectedAmount?: number): Promise<CheckoutPhase> => {
		state.phase = 'placing';
		state.error = null;
		state.stockConflict = false;
		state.quoteChange = null;
		state.shownTotal = shownTotalCents;
		checkoutState.isLoading = true;
		try {
			// One cart lock for the live read AND the order POST (it is not re-entrant: both use the scope it hands out).
			const created = await CartService.withLock(async (scope) => {
				CartService.setQuoteContext({ pricingIntent: 'checkout', shippingMethodCode: form.shippingMethodCode,
					shipCountry: typeof form.shippingAddress?.country === 'string' ? form.shippingAddress.country : undefined,
					...(form.redeemPoints ? { redeemPoints: form.redeemPoints } : {}) });
				// LOCKED: awaited live cart read before the order POST; a failure or an unavailable line stops here.
				// The validated read IS the submission snapshot: the order POST uses its token/revision, no second read.
				const snapshot = await refreshStockBeforeSubmit(scope);
				return srPlaceOrder(form, snapshot, scope);
			});
			state.code = created.code;
			state.receiptToken = created.receiptToken ?? '';
			state.grandTotal = created.grandTotal;
			state.clientSecret = '';
			state.method = method;

			const outcome = decideCheckoutStage(created);
			if (outcome.kind === 'paid') {
				if (outcome.needsSettle && !(await settleZeroDue(created.code, state.receiptToken))) {
					// The order exists but settlement is unproven: an error with the code kept, which the page recovers
					// through the resume view (a retry of the settlement), never a "paid" announcement.
					throw new Error("We couldn't confirm your order was paid. Please try again.");
				}
				state.phase = 'paid';
				return 'paid';
			}

			// Card path — mint the PaymentIntent and hand the client_secret to the Stripe Payment Element (mounted by
			// the caller). nmi/sezzle: nothing to mint up front — the NMI/Sezzle component calls startGatewayPayment
			// itself once mounted.
			// Express checkout passes the wallet's total: the intent is minted only when the order's amount due equals it.
			state.clientSecret = await initPayment(created.code, state.receiptToken, method, expectedAmount);
			state.phase = 'paying';
			return 'paying';
		} catch (error) {
			if (error instanceof QuoteChangedError) state.quoteChange = { quote: error.quote, quoteHash: error.quoteHash };
			if (error instanceof ConvertedCartError) {
				// The cart already became an order: nothing was POSTed and the token is kept. The page resumes that order.
				state.convertedCart = true;
				state.error = null;
				state.phase = 'error';
				return 'error';
			}
			const msg = error instanceof Error ? error.message : 'Checkout failed. Please try again.';
			state.error = msg;
			state.stockConflict = isOutOfStockConflict(error) || error instanceof PreSubmitStockError;
			checkoutState.error = msg;
			state.phase = 'error';
			return 'error';
		} finally {
			checkoutState.isLoading = false;
		}
	});

	/**
	 * Resume the ORIGINAL order behind a converted cart. Read-only lookup, then the stage decision, then payment
	 * initialisation only — no cart read, no stock/form validation, no order POST: the stored order and its payment
	 * authorisation are what is paid, whatever today's catalogue says. A failed lookup is a retryable error that keeps
	 * the token; it never falls through to order creation. `probe` marks a lookup made because the live cart read
	 * failed: its "no order" outcome is an unresolved cart, not a missing order. Returns the view the page should show.
	 */
	const resumeConverted = $(async (
		token: string,
		method: PaymentMethod | null = 'stripe',
		probe = false,
		// False once the page's view generation changed (method switch, newer resume, start-new-cart, page left): the lookup
		// then stops without writing state — checked after every await, before any state commit.
		isCurrent: () => boolean = () => true,
	): Promise<ResumeOutcome> => {
		// Whatever order this page showed before is gone from the view: a new lookup never inherits its code, token,
		// secret, phase or method (a cancelled / unknown / failed outcome would otherwise keep the old 'paying').
		Object.assign(state, { ...EMPTY_ORDER_STATE, resumeLines: [], resume: 'loading' as ResumeView });
		checkoutState.isLoading = true;
		try {
			const lookup = await CartService.lookupConvertedCheckout(token);
			if (!isCurrent()) return 'superseded';
			if (!lookup.ok) {
				// `probe`: the live cart read failed, so "no order" does not mean "no cart" — say the cart could not be loaded.
				state.error = probe
					? "We couldn't load your cart. Please try again."
					: lookup.reason === 'not_converted'
						? "We couldn't find the order for this cart. Please contact support."
						: "We couldn't load your order. Please try again.";
				state.resume = 'error';
				return 'error';
			}
			const { order } = lookup;
			state.code = order.code;
			state.receiptToken = order.receiptToken;
			state.grandTotal = order.grandTotal;
			// The shopper sees the order's own total on this page, so there is no estimate to confirm a change against.
			state.shownTotal = order.grandTotal;
			state.clientSecret = '';
			state.method = method;

			const stage = decideResumeStage(order.state, order.grandTotal);
			if (stage.kind === 'settled') {
				state.phase = 'paid';
				state.resume = 'settled';
				return 'settled';
			}
			if (stage.kind === 'cancelled') {
				state.resume = 'cancelled';
				return 'cancelled';
			}
			if (stage.kind === 'error') {
				state.error = "This order can't be paid right now. Please contact support.";
				state.resume = 'error';
				return 'error';
			}
			if (stage.kind === 'zero-due') {
				const proven = await settleZeroDue(order.code, order.receiptToken);
				if (!isCurrent()) return 'superseded';
				if (!proven) {
					state.error = "We couldn't confirm this order was paid. Please try again.";
					state.resume = 'error';
					return 'error';
				}
				state.phase = 'paid';
				state.resume = 'settled';
				return 'settled';
			}

			state.resumeLines = [];
			srGetOrder(order.code, order.receiptToken || undefined)
				.then((summary) => {
					if (!isCurrent()) return;
					state.resumeLines = (summary.lines ?? []).map((l) => ({ name: l.name, quantity: l.quantity }));
				})
				.catch(() => {
					/* the summary is a nicety: the order code and total are enough to pay */
				});
			const clientSecret = await initPayment(order.code, order.receiptToken, method);
			if (!isCurrent()) return 'superseded';
			state.clientSecret = clientSecret;
			state.phase = 'paying';
			state.resume = 'payable';
			return 'payable';
		} catch (error) {
			if (!isCurrent()) return 'superseded';
			state.error = error instanceof Error ? error.message : "We couldn't load your order. Please try again.";
			state.resume = 'error';
			return 'error';
		} finally {
			checkoutState.isLoading = false;
		}
	});

	return {
		checkoutState,
		state,
		placeOrder,
		resumeConverted,
		resetOrder,
	};
};
