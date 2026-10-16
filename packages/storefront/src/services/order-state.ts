/**
 * Pure classification of an order's `state` for the converted-cart flows. One
 * definition shared by the resume stage decision and the cart-slot retirement
 * check, so "is this order done?" can never be answered two ways.
 *
 * `settled`   — paid (or paid and since refunded/shipped): the shopper's cart slot is free to retire.
 * `cancelled` — will never be paid: the slot is free to retire.
 * `payable`   — still awaiting payment.
 * `unknown`   — anything else (`Declined`, `AddingItems`, a state this storefront has never seen). A failed payment
 *               attempt leaves the order `PendingPayment`, so `Declined` alone proves nothing: the token is kept.
 */
export type OrderStateKind = 'payable' | 'settled' | 'cancelled' | 'unknown';

const SETTLED = new Set(['Paid', 'PartiallyRefunded', 'Refunded', 'PartiallyShipped', 'Shipped', 'Delivered']);

export const classifyOrderState = (state: string | undefined | null): OrderStateKind => {
	if (state === 'PendingPayment') return 'payable';
	if (state === 'Cancelled') return 'cancelled';
	if (state && SETTLED.has(state)) return 'settled';
	return 'unknown';
};
