import { $, component$, useOnDocument } from '@qwik.dev/core';
import { useCart, loadCartIfNeeded } from '~/contexts/CartContext';
import Cart from './Cart';

interface ConditionalCartProps {
	isHomePage: boolean;
	showCart: boolean;
}

export default component$<ConditionalCartProps>(({ isHomePage, showCart }) => {
	const cart = useCart();

	// T20: Load cart on qinit
	useOnDocument('qinit', $(async () => {
		loadCartIfNeeded(cart);
	}));

	if (!isHomePage) {
		return <Cart />;
	} else {
		return showCart ? <Cart /> : null;
	}
});
