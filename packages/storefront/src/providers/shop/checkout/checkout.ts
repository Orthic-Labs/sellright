import {
	AddPaymentToOrderMutation,
	Order,
	PaymentInput,
} from '~/generated/graphql-shop';
import {
	AddPaymentToOrderDocument,
	type AddPaymentToOrderMutation as AddPaymentToOrderMutationT,
	type AddPaymentToOrderMutationVariables,
	TransitionOrderToStateDocument,
	type TransitionOrderToStateMutation,
	type TransitionOrderToStateMutationVariables,
} from '~/generated/graphql-shop-typed';
import { requester } from '~/utils/api';
import { CountryService } from '~/services/CountryService';
import { ShippingService } from '~/services/ShippingService';
import { PaymentService } from '~/services/PaymentService';
import {
	srCreateOrder,
	srCreatePaymentIntent,
	srPayOrder,
	type SrCreatedOrder,
} from '~/utils/sellright';

// ─────────────────────────────────────────────────────────────────────────────
// SellRight / Stripe checkout (behind VITE_SR_CHECKOUT). The Vendure NMI/Sezzle
// exports above stay as the DEFAULT path (flag off); these supersede them only
// when the flag is on. NMI/Sezzle are removed from THIS path only.
// ─────────────────────────────────────────────────────────────────────────────

/** Strangler flag: when truthy, checkout settles via SellRight + Stripe. */
export const SR_CHECKOUT_ENABLED =
	String(import.meta.env.VITE_SR_CHECKOUT ?? '').toLowerCase() === '1' ||
	String(import.meta.env.VITE_SR_CHECKOUT ?? '').toLowerCase() === 'true';

const SR_CART_COOKIE = 'sr_cart';

/** Read the server-cart token from the sr_cart cookie (set by ServerCartService). */
const srCartToken = (): string | null => {
	if (typeof document === 'undefined') return null;
	const m = document.cookie.match(new RegExp(`(?:^|; )${SR_CART_COOKIE}=([^;]*)`));
	return m ? decodeURIComponent(m[1]) : null;
};

export interface SrCheckoutForm {
	items?: { sku: string; quantity: number }[]; // fallback when no cart token
	email?: string;
	shippingAddress?: Record<string, unknown>;
	billingAddress?: Record<string, unknown>;
	shippingMethodCode?: string;
	couponCode?: string;
	giftCardCode?: string;
}

/**
 * Create the order (server-priced) from the sr_cart token. The server is
 * authoritative — when a cartToken is present its lines win and the client item
 * list is ignored. Returns the order code, totals, paid state, and the receipt
 * token to carry to the confirmation page (?rt=).
 */
export const placeOrder = async (form: SrCheckoutForm): Promise<SrCreatedOrder> => {
	const cartToken = srCartToken();
	const body: Record<string, unknown> = {
		shipping: 0,
		email: form.email,
		shippingAddress: form.shippingAddress,
		billingAddress: form.billingAddress,
		shippingMethodCode: form.shippingMethodCode,
		couponCode: form.couponCode,
		giftCardCode: form.giftCardCode,
	};
	if (cartToken) body.cartToken = cartToken;
	// /checkout requires a non-empty items[] in its schema even when cartToken
	// drives the actual lines; pass the client mirror as the bootstrap value.
	body.items = (form.items && form.items.length ? form.items : [{ sku: '__cart__', quantity: 1 }]);
	return srCreateOrder(body);
};

/** Mint (or reuse) the order's Stripe PaymentIntent → client_secret. */
export const createPaymentIntent = async (code: string): Promise<{ clientSecret: string; intentId: string }> =>
	srCreatePaymentIntent(code);

/**
 * Finalize a fully-gift-card-covered order (grandTotal == 0). When a gift card
 * covers the whole total, /checkout already returns state 'Paid' — this is the
 * fallback finalizer for the (rare) case it is still PendingPayment at 0 due.
 */
export const payWithGiftCardOnly = async (code: string): Promise<{ code: string; state: string; payment: string }> =>
	srPayOrder(code, 'manual');

// 🚀 CHECKOUT QUERY CACHE - Conservative 2-minute cache for checkout data
const checkoutCache = new Map<string, { data: any; timestamp: number }>();
const CHECKOUT_CACHE_DURATION = 2 * 60 * 1000; // 2 minutes (conservative for checkout)

const getCachedCheckoutQuery = (key: string) => {
	const cached = checkoutCache.get(key);
	if (cached && Date.now() - cached.timestamp < CHECKOUT_CACHE_DURATION) {
		return cached.data;
	}
	return null;
};

const setCachedCheckoutQuery = (key: string, data: any) => {
	checkoutCache.set(key, { data, timestamp: Date.now() });
	// Keep checkout cache small
	if (checkoutCache.size > 20) {
		const oldestKey = checkoutCache.keys().next().value;
		if (oldestKey) {
			checkoutCache.delete(oldestKey);
		}
	}
};

export const getAvailableCountriesQuery = async () => {
	return await CountryService.getAvailableCountries();
};

export const addPaymentToOrderMutation = async (
	input: PaymentInput = { method: 'standard-payment', metadata: {} }
) => {
	const result: AddPaymentToOrderMutation = await requester<AddPaymentToOrderMutationT, AddPaymentToOrderMutationVariables>(
		AddPaymentToOrderDocument,
		{ input }
	) as AddPaymentToOrderMutation;

	if (result.addPaymentToOrder && 'errorCode' in result.addPaymentToOrder) {
		throw new Error(result.addPaymentToOrder.message || 'Payment failed');
	}

	return result.addPaymentToOrder as Order;
};

export const transitionOrderToStateMutation = async (state = 'ArrangingPayment') => {
	console.log(`🔄 Attempting to transition order to state: ${state}`);

	try {
		const result = await requester<TransitionOrderToStateMutation, TransitionOrderToStateMutationVariables>(
			TransitionOrderToStateDocument,
			{ state }
		);
		console.log('🔄 Raw GraphQL result:', JSON.stringify(result, null, 2));

		// Check if the result contains an error
		if (result.transitionOrderToState && 'errorCode' in result.transitionOrderToState) {
			const error = result.transitionOrderToState;
			console.error('❌ Order state transition failed:', error);
			throw new Error(`Order state transition failed: ${error.message} (${error.errorCode})`);
		}

		// Check if we got a successful order back
		if (result.transitionOrderToState && 'state' in result.transitionOrderToState) {
			console.log(`✅ Order state transition successful. New state: ${result.transitionOrderToState.state}`);
			return result;
		}

		// If we get here, something unexpected happened
		console.error('❌ Unexpected transition response:', result);
		throw new Error('Unexpected response from order state transition');
	} catch (error) {
		console.error('❌ Error during order state transition:', error);
		throw error;
	}
};

export const getEligibleShippingMethodsQuery = async (countryCode: string, subtotal: number) => {
	return ShippingService.getEligibleShippingMethods(countryCode, subtotal);
};

export const getEligiblePaymentMethodsQuery = async () => {
	return PaymentService.getPaymentMethods();
};

// 🚀 CACHED CHECKOUT QUERIES - Conservative caching for better performance

export const getAvailableCountriesCached = async () => {
	const cacheKey = 'available-countries';
	const cached = getCachedCheckoutQuery(cacheKey);
	if (cached) return cached;

	try {
		const result = await getAvailableCountriesQuery();
		setCachedCheckoutQuery(cacheKey, result);
		return result;
	} catch (error) {
		console.warn('Countries cache failed, using fallback:', error);
		const result = await getAvailableCountriesQuery();
		setCachedCheckoutQuery(cacheKey, result);
		return result;
	}
};

export const getEligibleShippingMethodsCached = async (countryCode: string, subtotal: number) => {
	const cacheKey = `eligible-shipping-methods-${countryCode}-${subtotal}`;
	const cached = getCachedCheckoutQuery(cacheKey);
	if (cached) return cached;

	try {
		const result = await getEligibleShippingMethodsQuery(countryCode, subtotal);
		setCachedCheckoutQuery(cacheKey, result);
		return result;
	} catch (error) {
		console.warn('Shipping methods cache failed, using fallback:', error);
		const result = await getEligibleShippingMethodsQuery(countryCode, subtotal);
		setCachedCheckoutQuery(cacheKey, result);
		return result;
	}
};

export const getEligiblePaymentMethodsCached = async () => {
	const cacheKey = 'eligible-payment-methods';
	const cached = getCachedCheckoutQuery(cacheKey);
	if (cached) return cached;

	try {
		const result = await getEligiblePaymentMethodsQuery();
		setCachedCheckoutQuery(cacheKey, result);
		return result;
	} catch (error) {
		console.warn('Payment methods cache failed, using fallback:', error);
		const result = await getEligiblePaymentMethodsQuery();
		setCachedCheckoutQuery(cacheKey, result);
		return result;
	}
};

export const processNMIPayment = async (paymentToken:any) => {
	return addPaymentToOrderMutation({
		method: 'nmi',
		metadata: paymentToken
	});
};

// Sezzle Payment Processing
export const processSezzlePayment = async () => {
	try {
		console.log('[Sezzle] Processing payment...');

		// Add payment to order with Sezzle method
		const paymentResult = await addPaymentToOrderMutation({
			method: 'sezzle',
			metadata: {}
		});

		if (paymentResult) {
			return paymentResult;
		} else {
			throw new Error('Sezzle payment initialization failed');
		}
	} catch (error) {
		console.error('[Sezzle] Payment processing failed:', error);
		throw error;
	}
};
