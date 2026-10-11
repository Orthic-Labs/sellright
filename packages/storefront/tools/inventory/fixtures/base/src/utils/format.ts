// Formats a price for display.
export function formatPrice(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}
export const CURRENCY = 'USD';
