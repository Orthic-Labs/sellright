// The drawer's total (display only; the charge comes from the server and checkout re-quotes). M-L2/FC-3: the server quote's grand
// total when the cart carries a quote hash, else subtotal - discount + shipping, floored at 0 and labelled an estimate.
//
// 2026-11-10: the drawer's cart read carries no shipping method, so its quote has shippingTotal 0 while the drawer shows the
// shipping row from its own shipping quote. The total therefore swaps the quote's shipping for the shipping the drawer shows
// (grandTotal - cart.shippingTotal + shown shipping): tax and discounts stay the server's, and the total always equals the rows
// above it. It is "Total" only when the quote already carried that same shipping; otherwise it is an estimate.
export interface DrawerTotalCart { subtotal: number; discountTotal: number; grandTotal: number; shippingTotal?: number | null; quoteHash?: string | null }

export function drawerTotal(cart: DrawerTotalCart, shippingCents: number): { cents: number; label: 'Total' | 'Estimated total' } {
	if (cart.quoteHash) {
		const quoted = cart.shippingTotal || 0;
		return { cents: Math.max(0, cart.grandTotal - quoted + shippingCents), label: quoted === shippingCents ? 'Total' : 'Estimated total' };
	}
	return { cents: Math.max(0, cart.subtotal - (cart.discountTotal || 0) + shippingCents), label: 'Estimated total' };
}
