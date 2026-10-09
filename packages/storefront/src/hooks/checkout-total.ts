/**
 * Changed-total consent gate. The page shows the shopper an ESTIMATE (cart subtotal - discount + the quoted shipping);
 * the order that PLACE ORDER creates is priced by the server and its `grandTotal` is what the gateway will charge.
 * When the two differ (a stale quote, tax, a server-side adjustment) the shopper must see the old and the new
 * amount and confirm before any charge — never be charged a figure they were not shown.
 */
export interface TotalChange {
	/** The server total differs from the figure the shopper saw when they pressed PLACE ORDER. */
	changed: boolean;
	shownCents: number;
	chargeCents: number;
}

/** `shownCents <= 0` means no total was on screen (shipping unknown, empty estimate): nothing to compare against. */
export const totalChange = (shownCents: number, chargeCents: number): TotalChange => ({
	changed: shownCents > 0 && chargeCents !== shownCents,
	shownCents,
	chargeCents,
});

/** Same formatting the order-summary estimate uses ('$' + grouped 2-decimal amount). */
export const formatCents = (cents: number): string => '$' + (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
