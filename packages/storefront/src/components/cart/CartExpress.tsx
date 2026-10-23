import { $, component$, useContext, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { APP_STATE } from '~/constants';
import { useCart, refreshCartStock } from '~/contexts/CartContext';
import { CartService } from '~/services/CartService';
import { isLineAvailable } from '~/sellright/types/cart';
import { createPaymentIntent, getShopConfig, placeOrder } from '~/providers/shop/checkout/checkout';
import { refreshStockBeforeSubmit } from '~/hooks/pre-submit-stock';
import { ExpressCheckout } from '~/components/checkout/ExpressCheckout';
import { expressGateway, type ExpressGateway, type ExpressOrderForm, type ExpressOrderResult } from '~/components/checkout/express-checkout';
import { placeExpressOrder } from '~/components/checkout/express-order';

/**
 * Express wallets in the cart drawer, above CHECKOUT. It pays for the shopper's own cart, exactly as checkout's express
 * row does: the server quote for the wallet's destination, then (inside the cart lock) the live stock read and the order
 * created from that read with the quote's hash as consent, and the payment intent minted only for the wallet's total.
 */
export const CartExpress = component$<{ buttonHeight?: number }>((props) => {
	const appState = useContext(APP_STATE);
	const cartState = useCart();
	const config = useSignal<{ configured: boolean; key: string } | null>(null);
	const error = useSignal<string | null>(null);

	useVisibleTask$(async () => {
		try {
			const cfg = await getShopConfig();
			config.value = { configured: !!cfg.stripeConfigured, key: cfg.stripePublishableKey ?? '' };
		} catch {
			config.value = null;
		}
	});

	const cart = cartState.cart;
	const gateway: ExpressGateway | null = config.value
		? expressGateway({ gatewayConfigured: config.value.configured, publishableKey: config.value.key, currency: cart.currency || 'USD' })
		: null;
	// Only an active cart whose lines the last live read reported available; the quote re-checks stock on the server.
	const payable = !!cart.token && cart.lines.length > 0 && cart.status !== 'converted' && cart.status !== 'merged' && cart.lines.every(isLineAvailable);

	const onError$ = $(async (message: string) => {
		error.value = message;
		// Whatever failed (stock, a changed total, an order now waiting for payment), show the cart as the server has it.
		await refreshCartStock(cartState);
	});
	const onPlaceOrder$ = $(async (form: ExpressOrderForm, expectedAmount: number): Promise<ExpressOrderResult> => {
		error.value = null;
		return placeExpressOrder({
			// PLACE ORDER's lock and quote context (hooks/useCheckout.ts): the live read is priced as the wallet quote was.
			withCart: (fn) => CartService.withLock(async (scope) => {
				CartService.setQuoteContext({ pricingIntent: 'checkout', shippingMethodCode: form.shippingMethodCode,
					shipCountry: typeof form.shippingAddress.country === 'string' ? form.shippingAddress.country : undefined });
				return fn(scope);
			}).finally(() => CartService.setQuoteContext({})),
			validate: (scope) => refreshStockBeforeSubmit(scope),
			placeOrder: (f, snapshot, scope) => placeOrder(f, snapshot, scope),
			createPaymentIntent: (code, rt, amount) => createPaymentIntent(code, rt, amount),
		}, form, expectedAmount);
	});

	return (
		<div class="sr-cart-express mb-2" data-testid="cart-express">
			<ExpressCheckout
				gateway={gateway}
				cartToken={payable ? cart.token : null}
				country={appState.shippingAddress.countryCode || ''}
				couponCodes={[...(cart.couponCodes ?? [])]}
				redeemPoints={0}
				items={cart.lines.map((l) => ({ sku: l.sku, quantity: l.quantity }))}
				cartKey={`${cart.token}:${cart.revision}:${cart.quoteHash ?? ''}`}
				buttonHeight={props.buttonHeight}
				onPlaceOrder$={onPlaceOrder$}
				onError$={onError$}
				testId="cart-express-buttons"
			/>
			{error.value && <p role="alert" class="text-[11px] text-[#8a6d4a] mt-1">{error.value}</p>}
		</div>
	);
});
