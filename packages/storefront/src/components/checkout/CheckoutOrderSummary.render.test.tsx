// L11: the checkout order summary renders the route loader's server read at first paint (SSR), and the client's
// checkout-entry live read replaces it once it lands. Without a server read the loaded-height skeleton is unchanged.
import { $, component$, useContextProvider, useSignal, useStore } from '@qwik.dev/core';
import { QwikRouterMockProvider } from '@qwik.dev/router';
import { ssrRenderToDom, trigger } from '@qwik.dev/core/testing';
import { describe, expect, it } from 'vitest';
import { APP_STATE } from '~/constants';
import { CartContextId, type CartContextState } from '~/contexts/CartContext';
import { EMPTY_CART, type Cart } from '~/sellright/types/cart';
import type { AppState } from '~/types';
import { CheckoutOrderSummary } from './CheckoutOrderSummary';

const cart = (name: string, grandTotal: number): Cart => ({
	...EMPTY_CART,
	pricingIntent: 'checkout',
	quoteHash: 'qh',
	subtotal: 5000,
	shippingTotal: grandTotal - 5000,
	grandTotal,
	lines: [{ sku: 'SKU1', name, productName: name, quantity: 1, unitPrice: 5000, lineSubtotal: 5000, lineDiscount: 0, lineTotal: 5000, available: true, availableQuantity: 3, image: null } as Cart['lines'][number]],
});

const Host = component$<{ server: Cart | null }>((props) => {
	const appState = useStore({ shippingAddress: { countryCode: '' }, freeShipping: null } as unknown as AppState);
	useContextProvider(APP_STATE, appState);
	const cartState = useStore<CartContextState>({ cart: EMPTY_CART, isLoading: true, lastError: null, hasLoadedOnce: false, isRefreshingStock: false, notice: null, lastKnownQuantity: null });
	useContextProvider(CartContextId, cartState);
	const pageLoading = useSignal(true);
	const entryReadDone = useSignal(false);
	const serverCart = useSignal<Cart | null>(props.server);
	const formattedTotal = useSignal<string | null>(null);
	const shippingCents = useSignal<number | null>(null);
	const promoExpanded = useSignal(false);
	const loyalty = useSignal(null);
	return (
		<>
			<button id="land" onClick$={() => {
				// The client's entry read lands with its own (different) checkout quote.
				cartState.cart = cart('Client Widget', 6100);
				formattedTotal.value = '$61.00';
				entryReadDone.value = true;
			}} />
			<CheckoutOrderSummary
				formattedTotal={formattedTotal}
				hasMixedPreOrder={{ value: false }}
				localCart={cartState}
				pageLoading={pageLoading}
				serverCart={serverCart}
				entryReadDone={entryReadDone}
				promoExpanded={promoExpanded}
				shippingCents={shippingCents}
				loyalty={loyalty}
				onRedeemToggle$={$(async () => ({ ok: true }) as never)}
			/>
		</>
	);
});

const render = (server: Cart | null) =>
	ssrRenderToDom(<QwikRouterMockProvider url="http://localhost/checkout"><Host server={server} /></QwikRouterMockProvider>, { debug: false });

describe('CheckoutOrderSummary server-read first paint (L11)', () => {
	it('SSR shows the server read: lines, totals and the "Your order" total, no skeleton', async () => {
		const { document } = await render(cart('Server Widget', 5800));
		const html = document.body.innerHTML;
		expect(html).toContain('Server Widget');
		expect(html).toContain('$58.00');
		expect(html).not.toContain('animate-pulse');
	});

	it('without a server read SSR keeps the loaded-height skeleton', async () => {
		const { document } = await render(null);
		const html = document.body.innerHTML;
		expect(html).toContain('min-height:152px');
		expect(html).toContain('min-height:146px');
		expect(html).not.toContain('Server Widget');
	});

	it('the client entry read replaces the server read', async () => {
		const { document, container } = await render(cart('Server Widget', 5800));
		await trigger(container.element, '#land', 'click');
		// The visible summary only (the serialized loader state still carries the server read).
		const html = document.querySelector('.checkout-left')!.innerHTML;
		expect(html).toContain('Client Widget');
		expect(html).toContain('$61.00');
		expect(html).not.toContain('Server Widget');
		expect(html).not.toContain('$58.00');
	});
});
