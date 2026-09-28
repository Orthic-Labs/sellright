/**
 * ISO 4217 minor-unit lookup. Every amount that reaches this storefront over
 * the SellRight API is an integer count of the currency's minor unit (its
 * `Money` type — see packages/api `src/money/`) — but "minor unit" is NOT
 * always cents. Most currencies use 2 decimal places, several use 0 (whole
 * units only), and a handful use 3. Dividing by a hardcoded 100 and calling
 * `.toFixed(2)` is only correct for the 2-decimal majority; it silently
 * mis-prices JSON-LD `offers.price` (and any other minor-unit consumer) by
 * 10x/1000x for the others.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
	'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW',
	'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** Number of decimal places the given currency's minor unit represents. */
export function minorUnitDigits(currencyCode: string | undefined | null): number {
	const code = (currencyCode ?? '').toUpperCase();
	if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
	if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
	return 2;
}

/** Converts an integer minor-unit amount (e.g. cents) into the currency's
 *  major-unit decimal string (e.g. "12.34"), using the CORRECT number of
 *  decimal places for that currency rather than always assuming 2. */
export function formatMinorUnitsAsDecimalString(amountInMinorUnits: number, currencyCode: string | undefined | null): string {
	const digits = minorUnitDigits(currencyCode);
	const divisor = 10 ** digits;
	return (amountInMinorUnits / divisor).toFixed(digits);
}
