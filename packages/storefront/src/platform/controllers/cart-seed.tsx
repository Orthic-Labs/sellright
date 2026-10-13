// The cart-link seed page (L1): a client task runs the seed, then a full navigation to checkout (its own init reads the fresh cart).
import { component$, useContext, useVisibleTask$ } from '@qwik.dev/core';
import { APP_STATE } from '~/constants';
import { addToCartWithOutcome, useCart } from '~/contexts/CartContext';
import { CartService } from '~/services/CartService';
import { getOrResolveCountryCode } from '~/utils/addressStorage';
import { runCartSeed } from '~/platform/cart-seed';

export const CartSeedPage = component$(() => {
	const appState = useContext(APP_STATE);
	const cart = useCart();
	useVisibleTask$(async () => {
		const target = await runCartSeed(new URL(window.location.href).searchParams, {
			discard: () => CartService.discard(),
			add: (sku, quantity) => addToCartWithOutcome(cart, sku, quantity),
			resolveCountry: (override) => getOrResolveCountryCode(appState, override),
			totalQuantity: () => CartService.getCart().lines.reduce((sum, l) => sum + l.quantity, 0),
		});
		window.location.href = target;
	});
	return (
		<div class="flex items-center justify-center min-h-screen bg-white">
			<div class="text-center text-gray-900">
				<div class="animate-spin rounded-full h-12 w-12 border-b-2 border-black mx-auto"></div>
				<p class="mt-4">Preparing your cart...</p>
			</div>
		</div>
	);
});
