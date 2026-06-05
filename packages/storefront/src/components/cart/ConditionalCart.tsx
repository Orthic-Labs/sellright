import { $, component$, useOnDocument } from '@qwik.dev/core';
import { useLocalCart, loadCartIfNeeded } from '~/contexts/CartContext';
import Cart from './Cart';

interface ConditionalCartProps {
	isHomePage: boolean;
	showCart: boolean;
}

export default component$<ConditionalCartProps>(({ isHomePage, showCart }) => {
	const localCart = useLocalCart();

	// T20: Load cart on qinit
	useOnDocument('qinit', $(async () => {
		loadCartIfNeeded(localCart);
	}));

	if (!isHomePage) {
		return <Cart />;
	} else {
		return showCart ? <Cart /> : null;
	}
});
