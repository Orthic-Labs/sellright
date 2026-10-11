import { classifyOrderState } from '~/services/order-state';
import type { ConvertedLookup } from '~/services/CartService';

/** What the cart drawer knows about the order behind a converted cart: `null` = not looked up yet, `'loading'` = in flight. */
export type ConvertedLookupState = ConvertedLookup | 'loading' | null;

export interface CartBanner {
	/** Offer "Continue checkout" → /checkout. True for EVERY converted cart, even with empty or unavailable lines. */
	continueCheckout: boolean;
	/** Offer "Start a new cart". Only once the lookup proves the order settled or cancelled — an unpaid order gets no escape. */
	startNewCart: boolean;
	/** Neutral status line for the drawer, or null when there is nothing to say. */
	message: string | null;
}

const NONE: CartBanner = { continueCheckout: false, startNewCart: false, message: null };

/**
 * Pure drawer decision for a cart's status plus the converted-order lookup, kept out of the component because the
 * storefront has no component-render tests. A cart that is not converted shows the normal cart.
 */
export const cartBannerFor = (status: string | undefined, lookup: ConvertedLookupState): CartBanner => {
	if (status !== 'converted') return NONE;
	if (lookup === null || lookup === 'loading') {
		return { continueCheckout: true, startNewCart: false, message: 'Checking your order...' };
	}
	if (!lookup.ok) {
		return {
			continueCheckout: true,
			startNewCart: false,
			message:
				lookup.reason === 'not_converted'
					? "We couldn't find the order for this cart."
					: "We couldn't check this order right now.",
		};
	}
	switch (classifyOrderState(lookup.order.state)) {
		case 'settled':
			return { continueCheckout: true, startNewCart: true, message: 'This order is complete.' };
		case 'cancelled':
			return { continueCheckout: true, startNewCart: true, message: 'This order was cancelled.' };
		case 'payable':
			return { continueCheckout: true, startNewCart: false, message: 'You have an order waiting for payment.' };
		default:
			return { continueCheckout: true, startNewCart: false, message: "We couldn't confirm the status of this order." };
	}
};
