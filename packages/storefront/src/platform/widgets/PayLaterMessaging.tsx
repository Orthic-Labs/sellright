// Pay-later messaging a brand product view may place under the price line: the card gateway's Payment Method Messaging
// Element, as checkout shows it (components/checkout/CheckoutPaymentMessaging.tsx + payment-messaging.ts). It names only
// the installment methods enabled on the store's gateway account. Hidden while loading, without a configured gateway, for
// an unsupported currency or a non-positive amount, and whenever Stripe.js or the element fails to load.
import { component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { getShopConfig } from '~/providers/shop/checkout/checkout';
import { CheckoutPaymentMessaging } from '~/components/checkout/CheckoutPaymentMessaging';
import { paymentMessagingOptions } from '~/components/checkout/payment-messaging';

export interface PayLaterMessagingProps {
	/** Price in minor units (cents), e.g. the selected variant's price. */
	amount: number;
	/** ISO currency, e.g. `product.currencyCode`. */
	currency: string;
}

export const PayLaterMessaging = component$<PayLaterMessagingProps>((props) => {
	const gateway = useSignal<{ configured: boolean; key: string } | null>(null);
	useVisibleTask$(async () => {
		try {
			const cfg = await getShopConfig();
			gateway.value = { configured: !!cfg.stripeConfigured, key: cfg.stripePublishableKey ?? '' };
		} catch {
			gateway.value = null;
		}
	// The rendered wrapper is display:none until the element is ready, so it never intersects: run on document ready.
	}, { strategy: 'document-ready' });
	const options = paymentMessagingOptions({
		gatewayConfigured: gateway.value?.configured,
		publishableKey: gateway.value?.key,
		amountCents: props.amount,
		currency: props.currency,
	});
	return <CheckoutPaymentMessaging options={options} testId="pay-later-messaging" marginBottom="0" />;
});
