export function formatPrice(cents: number): string {
	return `EUR ${(cents / 100).toFixed(2)}`;
}
export const CURRENCY = 'USD';
export function formatTax(cents: number): string {
	return `${(cents / 100).toFixed(2)} tax`;
}
