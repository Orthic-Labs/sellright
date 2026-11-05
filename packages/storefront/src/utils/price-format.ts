// Pure price formatting with no imports: presentation components (L2) may reach it, unlike the ~/utils barrel (which pulls in
// constants and env). `DEFAULT_CURRENCY` is defined here and re-exported by ~/constants.
export const DEFAULT_CURRENCY = 'USD';

/** A shipping amount: a free shipping line reads "Free" everywhere (cart, checkout, order pages), never "$0" (#401). */
export function formatShippingPrice(value = 0, currencyCode?: string) {
	return value === 0 ? 'Free' : formatPrice(value, currencyCode);
}

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
