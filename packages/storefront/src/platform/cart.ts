// A13: cart-toggle orchestration moved verbatim out of src/components/header/header.tsx (L2) so the header no longer
// calls refreshCartStock itself. The returned QRL has the same body and the same captures (appState, cart) as the
// inline onClick$ closure it replaces.
import { $, useContext } from '@qwik.dev/core';
import { APP_STATE } from '~/constants';
import { CountryPreferenceService } from '~/services/CountryPreferenceService';
import { useCart, refreshCartStock, loadCartIfNeeded } from '~/contexts/CartContext';

export const useCartToggle = () => {
	const appState = useContext(APP_STATE);
	const cart = useCart();
	return $(async () => {
		if (!appState.shippingAddress.countryCode) {
			appState.shippingAddress.countryCode = CountryPreferenceService.getCountry();
		}
		if (appState.showCart) {
			appState.showCart = false;
		} else {
			loadCartIfNeeded(cart);
			appState.showCart = true;
			// LOCKED stock rule: live refresh on every cart open, no
			// cache/TTL/debounce — see CartContext.tsx refreshCartStock.
			refreshCartStock(cart).catch(console.error);
		}
	});
};
