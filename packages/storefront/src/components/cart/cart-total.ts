// The drawer's total (display only; the charge comes from the server and checkout re-quotes). M-L2/FC-3: the server quote's grand
// total when the cart carries a quote hash, else subtotal - discount + shipping, floored at 0 and labelled an estimate.
export interface DrawerTotalCart { subtotal: number; discountTotal: number; grandTotal: number; quoteHash?: string | null }

export function drawerTotal(cart: DrawerTotalCart, shippingCents: number): { cents: number; label: 'Total' | 'Estimated total' } {
	if (cart.quoteHash) return { cents: Math.max(0, cart.grandTotal), label: 'Total' };
	return { cents: Math.max(0, cart.subtotal - (cart.discountTotal || 0) + shippingCents), label: 'Estimated total' };
}
