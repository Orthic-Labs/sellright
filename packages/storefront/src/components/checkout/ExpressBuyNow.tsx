import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { createPaymentIntent, getShopConfig, placeOrder } from '~/providers/shop/checkout/checkout';
import { refreshStockBeforeSubmit } from '~/hooks/pre-submit-stock';
import { CountryPreferenceService } from '~/services/CountryPreferenceService';
import { ExpressCheckout } from './ExpressCheckout';
import { buyNowItems, expressGateway, type ExpressGateway, type ExpressOrderForm, type ExpressOrderResult } from './express-checkout';
import { createBuyNowCart, detachedCartScope, placeExpressOrder } from './express-order';

export interface ExpressBuyNowProps {
	/** The variant the complete option selection resolves to; null (no complete selection) shows no button. */
	sku: string | null;
	/** The product's currency (view data `currencyCode`). */
	currency: string;
	/** Match the brand's ADD TO CART height (40–55px); omitted = the gateway default (44px). */
	buttonHeight?: number;
	/** Apple Pay / Google Pay only, as a single button (e.g. beside ADD TO CART in a phone's sticky bar). */
	walletsOnly?: boolean;
}

/**
 * PDP buy-now through the express wallets. It buys exactly ONE unit of the selected variant through its own single-line
 * server cart (express-order.ts `createBuyNowCart`): the shopper's cart is never read, changed or merged. The cart is
 * created only once a complete variant is selected and the device has an express method, and is replaced when the
 * variant changes. The button shows only with a server quote for that cart (so never without a variant, and never for a
 * variant the live stock read refuses); confirm runs the same live stock read, quote-hash consent and exact-amount
 * payment intent as checkout, then lands on the checkout confirmation page (purchase fires there, once per order).
 */
export const ExpressBuyNow = component$<ExpressBuyNowProps>((props) => {
	const gateway = useSignal<ExpressGateway | null>(null);
	const available = useSignal(false);
	const cartToken = useSignal<string | null>(null);
	const country = useSignal('');
	const error = useSignal<string | null>(null);

	useVisibleTask$(async ({ track }) => {
		const currency = track(() => props.currency);
		country.value = CountryPreferenceService.getCountry();
		try {
			const cfg = await getShopConfig();
			gateway.value = expressGateway({ gatewayConfigured: cfg.stripeConfigured, publishableKey: cfg.stripePublishableKey, currency });
		} catch {
			gateway.value = null;
		}
	});

	// One buy-now cart per selected variant, made only when a button could show for it.
	useVisibleTask$(async ({ track, cleanup }) => {
		const items = buyNowItems(track(() => props.sku));
		const ok = track(() => available.value);
		const g = track(() => gateway.value);
		cartToken.value = null;
		error.value = null;
		if (!items || !ok || !g) return;
		let stale = false;
		cleanup(() => { stale = true; });
		try {
			const token = await createBuyNowCart(items);
			if (!stale) cartToken.value = token;
		} catch {
			// No cart, no button: the shopper still has ADD TO CART.
		}
	});

	const onAvailability$ = $((a: boolean) => { available.value = a; });
	const onError$ = $((message: string) => { error.value = message; });
	const onPlaceOrder$ = $(async (form: ExpressOrderForm, expectedAmount: number): Promise<ExpressOrderResult> => {
		const token = cartToken.value;
		if (!token) return { ok: false, message: 'Please choose your options and try again.' };
		error.value = null;
		const shipCountry = String(form.shippingAddress.country ?? '');
		return placeExpressOrder({
			withCart: (fn) => fn(detachedCartScope(token, { shipCountry, shippingMethodCode: form.shippingMethodCode })),
			validate: (scope) => refreshStockBeforeSubmit(scope),
			placeOrder: (f, snapshot, scope) => placeOrder(f, snapshot, scope),
			createPaymentIntent: (code, rt, amount) => createPaymentIntent(code, rt, amount),
		}, form, expectedAmount);
	});

	return (
		<div class="sr-express-buy-now" data-testid="express-buy-now">
			<ExpressCheckout
				gateway={gateway.value}
				cartToken={cartToken.value}
				country={country.value}
				couponCodes={[]}
				redeemPoints={0}
				items={buyNowItems(props.sku) ?? []}
				cartKey={cartToken.value ?? ''}
				buttonHeight={props.buttonHeight}
				walletsOnly={props.walletsOnly}
				singleRow={!props.walletsOnly}
				onAvailability$={onAvailability$}
				onPlaceOrder$={onPlaceOrder$}
				onError$={onError$}
				testId="express-buy-now-buttons"
			/>
			{error.value && <p role="alert" style="font-size:12px;margin-top:6px;">{error.value}</p>}
		</div>
	);
});
