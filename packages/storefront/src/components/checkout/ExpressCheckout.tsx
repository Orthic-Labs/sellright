import { component$, useSignal, useVisibleTask$, type QRL } from '@qwik.dev/core';
import { loadStripe, type StripeElements, type StripeExpressCheckoutElement } from '@stripe/stripe-js';
import { getExpressQuote } from '~/providers/shop/checkout/checkout';
import {
	expressElementOptions,
	hasExpressMethod,
	isChargeableQuote,
	runExpressConfirm,
	toWalletQuote,
	type ExpressGateway,
	type ExpressOrderForm,
	type ExpressOrderResult,
	type WalletQuote,
} from './express-checkout';

/**
 * Express wallet buttons (the card gateway's Express Checkout Element): at the top of checkout, in the cart drawer and
 * (through ExpressBuyNow) on a product page. Client-only: Stripe.js is imperative and never runs during SSR. Rendered
 * hidden and revealed only when the gateway reports an express method available on this device and domain AND a server
 * quote exists for the cart and destination — no fake buttons. Every amount in the sheet comes from the API
 * (express-checkout.ts); confirm goes through `onPlaceOrder$`, which creates the order the way PLACE ORDER does.
 */
export interface ExpressCheckoutProps {
	/** The gateway account to mount for; null mounts nothing. Kept separate from the cart so the element can report the
	 *  device's wallets before a cart exists (PDP buy-now creates its cart only then). */
	gateway: ExpressGateway | null;
	/** The cart the wallet quotes and orders; null = no button (no cart, no complete selection, an order in progress). */
	cartToken: string | null;
	/** Destination country the page currently prices with (the wallet replaces it with the shopper's own). */
	country: string;
	/** The cart's quote inputs, re-sent with every wallet quote and with the order. */
	couponCodes: string[];
	redeemPoints: number;
	items: { sku: string; quantity: number }[];
	/** Changes whenever the cart is repriced (revision, lines, coupons) so the pre-quote is refreshed. */
	cartKey: string;
	onPlaceOrder$: QRL<(form: ExpressOrderForm, expectedAmount: number) => Promise<ExpressOrderResult>>;
	onError$: QRL<(message: string) => void>;
	/** Wallet button height in px (40–55, the brand's ADD TO CART); omitted = the gateway default. Read once at mount. */
	buttonHeight?: number;
	/** Apple Pay / Google Pay only, one button, no overflow (a slot with room for one button). Read once at mount. */
	walletsOnly?: boolean;
	/** The "Or continue below" line: only where a payment form follows (checkout). */
	continueHint?: boolean;
	/** Reports whether this device has an express method (fires once the element is ready, false on a load error). */
	onAvailability$?: QRL<(available: boolean) => void>;
	testId?: string;
}

export const ExpressCheckout = component$<ExpressCheckoutProps>((props) => {
	const hostRef = useSignal<HTMLElement>();
	const walletAvailable = useSignal(false);
	const quoted = useSignal(false);
	const elementsRef = useSignal<unknown>(null);
	// The quote for the page's destination (what the button opens with) and the one the open sheet shows.
	const baseQuote = useSignal<WalletQuote | null>(null);
	const sheetQuote = useSignal<WalletQuote | null>(null);
	const sheetOpen = useSignal(false);
	const quotedToken = useSignal<string | null>(null);
	// The gateway account the element is mounted for. It only ever changes to another non-null account: when the cart
	// turns null (the wallet's own confirm just created the order) the element must stay alive until its payment confirms.
	const mounted = useSignal<ExpressGateway | null>(null);
	useVisibleTask$(({ track }) => {
		const g = track(() => props.gateway);
		const m = mounted.value;
		if (g && (!m || m.publishableKey !== g.publishableKey || m.currency !== g.currency)) mounted.value = { publishableKey: g.publishableKey, currency: g.currency };
	});

	// Pre-quote the page's destination: the click handler must answer within a second, so it never waits on the API.
	useVisibleTask$(async ({ track, cleanup }) => {
		const options = track(() => mounted.value);
		const token = track(() => props.cartToken);
		const country = track(() => props.country);
		track(() => props.cartKey);
		const coupons = track(() => props.couponCodes.join('\n'));
		const points = track(() => props.redeemPoints);
		let stale = false;
		cleanup(() => { stale = true; });
		// The quote belongs to one cart: a new cart (or none) never keeps the previous cart's total for its click.
		if (!options || !token || !country || token !== quotedToken.value) { baseQuote.value = null; quoted.value = false; }
		quotedToken.value = token;
		if (!options || !token || !country) return;
		try {
			const q = await getExpressQuote(token, { country, couponCodes: coupons ? coupons.split('\n') : [], ...(points > 0 ? { redeemPoints: points } : {}) });
			if (stale) return;
			const wq = toWalletQuote(country, q);
			baseQuote.value = isChargeableQuote(wq) && wq.currency === options.currency ? wq : null;
		} catch {
			// No quote (no shipping to this country, an item sold out, offline): no express button rather than a guessed total.
			if (!stale) baseQuote.value = null;
		}
		if (stale) return;
		quoted.value = !!baseQuote.value;
		const elements = elementsRef.value as StripeElements | null;
		if (elements && baseQuote.value && !sheetOpen.value) elements.update({ amount: baseQuote.value.grandTotal });
	});

	// Mount once per gateway account + currency.
	useVisibleTask$(async ({ track, cleanup }) => {
		const options = track(() => mounted.value);
		const host = track(() => hostRef.value);
		const key = options?.publishableKey ?? '';
		if (!options || !host || !key) return;
		let disposed = false;
		let element: StripeExpressCheckoutElement | null = null;
		cleanup(() => {
			disposed = true;
			try { element?.destroy(); } catch { /* already destroyed */ }
			elementsRef.value = null;
			walletAvailable.value = false;
		});
		try {
			const stripe = await loadStripe(key);
			if (disposed || !stripe) return;
			// Deferred intent: the amount here is display only; the intent is minted server-side for the order's amount due.
			const elements = stripe.elements({ mode: 'payment', amount: baseQuote.value?.grandTotal || 100, currency: options.currency });
			// Checkout prices tax (and shipping) by the destination, so the wallet always supplies one — as the form does.
			const ece = elements.create('expressCheckout', expressElementOptions({ buttonHeight: props.buttonHeight, walletsOnly: props.walletsOnly }));
			element = ece;
			const fail = (message: string) => { void props.onError$(message); };

			ece.on('ready', (ev) => {
				if (disposed) return;
				walletAvailable.value = hasExpressMethod(ev.availablePaymentMethods);
				void props.onAvailability$?.(walletAvailable.value);
			});
			ece.on('loaderror', () => {
				if (disposed) return;
				walletAvailable.value = false;
				void props.onAvailability$?.(false);
			});
			ece.on('click', (ev) => {
				const q = baseQuote.value;
				if (!isChargeableQuote(q)) { ev.reject(); return; }
				sheetQuote.value = q;
				sheetOpen.value = true;
				elements.update({ amount: q.grandTotal });
				ev.resolve({ shippingRates: q.rates });
			});
			ece.on('cancel', () => {
				sheetOpen.value = false;
				sheetQuote.value = null;
				if (baseQuote.value) elements.update({ amount: baseQuote.value.grandTotal });
			});
			const requote = async (country: string, shippingMethodCode?: string): Promise<WalletQuote | null> => {
				const o = mounted.value;
				const token = props.cartToken;
				if (!o || !token) return null;
				try {
					const q = await getExpressQuote(token, { country, ...(shippingMethodCode ? { shippingMethodCode } : {}),
						couponCodes: [...props.couponCodes], ...(props.redeemPoints > 0 ? { redeemPoints: props.redeemPoints } : {}) });
					const wq = toWalletQuote(country, q);
					return isChargeableQuote(wq) && wq.currency === o.currency ? wq : null;
				} catch {
					return null;
				}
			};
			ece.on('shippingaddresschange', async (ev) => {
				const q = await requote(ev.address.country, sheetQuote.value?.shippingMethodCode ?? undefined);
				// Unserviceable destination or sold-out line: refuse in the sheet; the previous total is never kept for a new address.
				if (!q) { sheetQuote.value = null; ev.reject(); return; }
				sheetQuote.value = q;
				elements.update({ amount: q.grandTotal });
				ev.resolve({ shippingRates: q.rates });
			});
			ece.on('shippingratechange', async (ev) => {
				const current = sheetQuote.value;
				const q = current ? await requote(current.country, ev.shippingRate.id) : null;
				if (!q || (current?.requiresShipping && q.shippingMethodCode !== ev.shippingRate.id)) { ev.reject(); return; }
				sheetQuote.value = q;
				elements.update({ amount: q.grandTotal });
				ev.resolve({ shippingRates: q.rates });
			});
			ece.on('confirm', async (ev) => {
				const outcome = await runExpressConfirm({
					quote: () => sheetQuote.value,
					extra: () => ({ items: [...props.items], couponCodes: [...props.couponCodes], redeemPoints: props.redeemPoints }),
					submit: async () => {
						const { error } = await elements.submit();
						return error ? (error.message || 'Your payment details could not be confirmed.') : null;
					},
					placeOrder: (form, expectedAmount) => props.onPlaceOrder$(form, expectedAmount),
					confirm: async (clientSecret, returnUrl) => {
						const { error } = await stripe.confirmPayment({ elements, clientSecret, confirmParams: { return_url: returnUrl } });
						return error ? (error.message || 'Payment could not be completed.') : null;
					},
					returnUrl: (code, rt) => `${location.origin}/checkout/confirmation/${encodeURIComponent(code)}${rt ? `?rt=${encodeURIComponent(rt)}` : ''}`,
				}, ev);
				if (!outcome.ok) {
					ev.paymentFailed({ reason: outcome.reason, message: outcome.message });
					sheetOpen.value = false;
					fail(outcome.message);
				}
			});
			ece.mount(host);
			elementsRef.value = elements as unknown;
		} catch (e) {
			console.warn('[Checkout] express checkout failed to load:', e);
			walletAvailable.value = false;
			void props.onAvailability$?.(false);
		}
	});

	const visible = !!props.cartToken && walletAvailable.value && quoted.value;
	return (
		// Kept mounted (not display:none) while hidden so the gateway can still report wallet availability.
		<div class="checkout-express" data-testid={props.testId ?? 'checkout-express'} aria-hidden={!visible}
			style={visible ? { marginBottom: props.continueHint ? '16px' : '0' } : { visibility: 'hidden', height: '0', overflow: 'hidden', pointerEvents: 'none' }}>
			<div ref={hostRef} />
			{props.continueHint && <p style="text-align:center;font-size:12px;opacity:0.6;margin-top:8px;">Or continue below to pay another way</p>}
		</div>
	);
});
