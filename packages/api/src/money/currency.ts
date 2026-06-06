/**
 * Presentment-currency conversion (display only). Rates are stored as units of
 * the target currency per 1 base unit, scaled ×10000. Conversion is for display
 * on the storefront; orders are still charged in the store's base currency.
 */
export const RATE_SCALE = 10000;

/** Convert integer base-currency cents to integer target-currency cents. */
export function convertMoney(baseCents: number, rateScaled: number): number {
  return Math.round((baseCents * rateScaled) / RATE_SCALE);
}

/** Pick the rate for `currency` (1.0 for the base currency or when unlisted). */
export function rateFor(rates: Array<{ currency: string; rate: number; enabled: boolean }>, baseCurrency: string, currency: string): number {
  if (currency.toUpperCase() === baseCurrency.toUpperCase()) return RATE_SCALE;
  const r = rates.find((x) => x.enabled && x.currency.toUpperCase() === currency.toUpperCase());
  return r ? r.rate : RATE_SCALE; // unknown currency → no conversion (base)
}
