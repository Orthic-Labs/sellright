// #446: the cart drawer / cart page / checkout summary line list tells the shopper which lines ship later and that the order ships
// together. The text comes from the live cart read's line fields (`backorder`, `shipLabel`); absent fields mean a normal line.
import { component$, useContextProvider, useStore } from '@qwik.dev/core';
import { QwikRouterMockProvider } from '@qwik.dev/router';
import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it } from 'vitest';
import { APP_STATE } from '~/constants';
import { CartContextId, type CartContextState } from '~/contexts/CartContext';
import { EMPTY_CART, type Cart } from '~/sellright/types/cart';
import type { AppState } from '~/types';
import CartContents from './CartContents';

const L = (sku: string, over: Record<string, unknown> = {}) =>
	({ sku, name: `Item ${sku}`, productName: `Item ${sku}`, quantity: 1, unitPrice: 5000, lineSubtotal: 5000, lineDiscount: 0, lineTotal: 5000, available: true, availableQuantity: 5, image: null, ...over }) as Cart['lines'][number];
const cartOf = (...lines: Cart['lines']): Cart => ({ ...EMPTY_CART, lines, subtotal: 5000, grandTotal: 5000 });

const Host = component$<{ cart: Cart }>((props) => {
	const appState = useStore({ shippingAddress: { countryCode: '' }, freeShipping: null } as unknown as AppState);
	useContextProvider(APP_STATE, appState);
	const cartState = useStore<CartContextState>({ cart: props.cart, isLoading: false, lastError: null, hasLoadedOnce: true, isRefreshingStock: false, notice: null, lastKnownQuantity: null });
	useContextProvider(CartContextId, cartState);
	return <CartContents />;
});
const render = (cart: Cart, path = '/') =>
	ssrRenderToDom(<QwikRouterMockProvider url={`http://localhost${path}`}><Host cart={cart} /></QwikRouterMockProvider>, { debug: false });

describe('CartContents backorder notices (#446)', () => {
	it('a backorder line shows its label (still buyable: quantity control stays) and the order sentence once', async () => {
		const { document } = await render(cartOf(L('A', { backorder: true, shipLabel: 'Ships in 3 weeks', shipsNowQuantity: 0 }), L('B')));
		const notes = [...document.querySelectorAll('[data-backorder-line]')];
		expect(notes.map((n) => n.textContent?.trim())).toEqual(['Ships in 3 weeks']);
		expect(document.querySelectorAll('[data-backorder-order-note]')).toHaveLength(1);
		expect(document.querySelector('[data-backorder-order-note]')?.getAttribute('aria-live')).toBe('polite');
		expect(document.body.textContent).toContain('Your whole order ships together when these items arrive.');
		expect(document.querySelector('[data-backorder-order-note]')?.textContent).not.toContain('!');
	});
	it('a backorder line without a label says "Ships later"', async () => {
		const { document } = await render(cartOf(L('A', { backorder: true, shipLabel: null })));
		expect(document.querySelector('[data-backorder-line]')?.textContent?.trim()).toBe('Ships later');
	});
	it('the checkout summary shows the same notices', async () => {
		const { document } = await render(cartOf(L('A', { backorder: true, shipLabel: 'Ships in 3 weeks' })), '/checkout');
		expect(document.querySelector('[data-backorder-line]')?.textContent?.trim()).toBe('Ships in 3 weeks');
		expect(document.querySelectorAll('[data-backorder-order-note]')).toHaveLength(1);
	});
	it('no backorder (or an older API without the fields) shows neither notice', async () => {
		const { document } = await render(cartOf(L('A'), L('B', { backorder: false, shipLabel: 'Ships in 3 weeks' })));
		expect(document.querySelector('[data-backorder-line]')).toBeFalsy();
		expect(document.querySelector('[data-backorder-order-note]')).toBeFalsy();
	});
});
