// Express wallet buy-now a brand product view may place directly under ADD TO CART. It wraps the L1 ExpressBuyNow (gateway
// config, the dedicated single-line buy-now cart, server quotes, live stock read and order creation stay in L1); the brand
// passes the selection's resolved variant and its own ADD TO CART height. No complete selection (`sku` null) = no button.
import { component$ } from '@qwik.dev/core';
import { ExpressBuyNow } from '~/components/checkout/ExpressBuyNow';

export interface ExpressBuyButtonsProps {
	/** `selection.variantSku`: the variant a complete selection resolves to, or null. */
	sku: string | null;
	/** `product.currencyCode`. */
	currency: string;
	/** Always one unit: buy-now never takes the configurator quantity. */
	quantity?: 1;
	/** px, 40–55 (clamped); match the ADD TO CART button. Omitted = 44. */
	buttonHeight?: number;
	/** Apple Pay / Google Pay only, as one button with no Link, Klarna or overflow: for a slot with room for exactly one
	 *  button, such as a phone's sticky bar beside ADD TO CART. Omitted = the full express row. Read once at mount. */
	walletsOnly?: boolean;
}

// Layout (#347): without walletsOnly the buttons sit side by side in ONE row (never a lone full-width bar). While visible,
// the inner .checkout-express carries data-express-methods (e.g. "link" when Link is the only method on this device), so a
// brand can place a lone button beside its ADD TO CART with CSS alone, e.g.
//   .buy-row:has(.checkout-express[data-express-methods="link"]) { display: flex; }

export const ExpressBuyButtons = component$<ExpressBuyButtonsProps>((props) => (
	<ExpressBuyNow sku={props.sku} currency={props.currency} buttonHeight={props.buttonHeight} walletsOnly={props.walletsOnly} />
));
