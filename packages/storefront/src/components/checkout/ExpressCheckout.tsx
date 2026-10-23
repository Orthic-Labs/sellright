import { component$, useSignal, useVisibleTask$, type QRL } from '@qwik.dev/core';
import { loadStripe, type StripeElements, type StripeExpressCheckoutElement } from '@stripe/stripe-js';
import { getExpressQuote } from '~/providers/shop/checkout/checkout';
import {
	isChargeableQuote,
	runExpressConfirm,
	toWalletQuote,
	type ExpressCheckoutOptions,
	type ExpressOrderForm,
	type ExpressOrderResult,
	type WalletQuote,
} from './express-checkout';

/**
 * Apple Pay / Google Pay at the top of checkout (the card gateway's Express Checkout Element). Client-only: Stripe.js is
 * imperative and never runs during SSR. Rendered hidden and revealed only when the gateway reports Apple Pay or Google
 * Pay available on this device and domain AND a server quote exists for the page's destination — no fake buttons.
 * Every amount in the sheet comes from the API (express-checkout.ts); confirm goes through `onPlaceOrder$`, PLACE
 * ORDER's own order path.
 */
export interface ExpressCheckoutProps {
	options: ExpressCheckoutOptions | null;
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
	// The gateway account the element is mounted for. It only ever changes to another non-null account: when `options`
	// turns null (the wallet's own confirm just created the order) the element must stay alive until its payment confirms.
	const mounted = useSignal<ExpressCheckoutOptions | null>(null);
	useVisibleTask$(({ track }) => {
		const o = track(() => props.options);
		const m = mounted.value;
		if (o && (!m || m.publishableKey !== o.publishableKey || m.currency !== o.currency || m.cartToken !== o.cartToken)) mounted.value = o;
	});

	// Pre-quote the page's destination: the click handler must answer within a second, so it never waits on the API.
	useVisibleTask$(async ({ track, cleanup }) => {
		const options = track(() => props.options);
		const country = track(() => props.country);
		track(() => props.cartKey);
		const coupons = track(() => props.couponCodes.join('\n'));
		const points = track(() => props.redeemPoints);
		let stale = false;
		cleanup(() => { stale = true; });
		if (!options || !country) { baseQuote.value = null; quoted.value = false; return; }
		try {
			const q = await getExpressQuote(options.cartToken, { country, couponCodes: coupons ? coupons.split('\n') : [], ...(points > 0 ? { redeemPoints: points } : {}) });
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
			const ece = elements.create('expressCheckout', {
				emailRequired: true,
				phoneNumberRequired: true,
				// Checkout prices tax (and shipping) by the destination, so the wallet always supplies one — as the form does.
				shippingAddressRequired: true,
				paymentMethods: { applePay: 'auto', googlePay: 'auto', link: 'never', paypal: 'never', amazonPay: 'never', klarna: 'never' },
				buttonType: { applePay: 'buy', googlePay: 'buy' },
			});
			element = ece;
			const fail = (message: string) => { void props.onError$(message); };

			ece.on('ready', (ev) => {
				if (disposed) return;
				const a = ev.availablePaymentMethods;
				walletAvailable.value = !!(a && (a.applePay || a.googlePay));
			});
			ece.on('loaderror', () => { if (!disposed) walletAvailable.value = false; });
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
				if (!o) return null;
				try {
					const q = await getExpressQuote(o.cartToken, { country, ...(shippingMethodCode ? { shippingMethodCode } : {}),
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
		}
	});

	const visible = !!props.options && walletAvailable.value && quoted.value;
	return (
		// Kept mounted (not display:none) while hidden so the gateway can still report wallet availability.
		<div class="checkout-express" data-testid="checkout-express" aria-hidden={!visible}
			style={visible ? { marginBottom: '16px' } : { visibility: 'hidden', height: '0', overflow: 'hidden', pointerEvents: 'none' }}>
			<div ref={hostRef} />
			<p style="text-align:center;font-size:12px;opacity:0.6;margin-top:8px;">Or continue below to pay another way</p>
		</div>
	);
});
