// Pure price formatting with no imports: presentation components (L2) may reach it, unlike the ~/utils barrel (which pulls in
// constants and env). `DEFAULT_CURRENCY` is defined here and re-exported by ~/constants.
export const DEFAULT_CURRENCY = 'USD';

export function formatPrice(value = 0, currencyCode?: string) {
	const amount = value / 100;
	const hasDecimals = amount % 1 !== 0;
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: currencyCode || DEFAULT_CURRENCY,
		minimumFractionDigits: hasDecimals ? 2 : 0,
		maximumFractionDigits: hasDecimals ? 2 : 0,
	}).format(amount);
}
