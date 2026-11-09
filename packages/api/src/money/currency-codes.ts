/**
 * ISO 4217 currencies with a two-decimal minor unit: the only ones the money code handles correctly (all amounts are
 * integer cents, gateways are sent amount / 100). Zero- and three-decimal currencies (JPY, KRW, KWD, BHD ...) and the
 * ones payment providers special-case (HUF, TWD, ISK, UGX) are deliberately absent.
 */
export const TWO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'AED', 'ANG', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BWP', 'BYN', 'BZD',
  'CAD', 'CHF', 'CNY', 'COP', 'CRC', 'CZK', 'DKK', 'DOP', 'DZD', 'EGP', 'ETB', 'EUR', 'FJD', 'GBP', 'GEL', 'GHS', 'GIP', 'GTQ',
  'GYD', 'HKD', 'HNL', 'IDR', 'ILS', 'INR', 'JMD', 'KES', 'KGS', 'KHR', 'KYD', 'KZT', 'LKR', 'MAD', 'MDL', 'MKD', 'MMK', 'MOP',
  'MUR', 'MXN', 'MYR', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'PAB', 'PEN', 'PHP', 'PKR', 'PLN', 'QAR', 'RON', 'RSD', 'SAR',
  'SCR', 'SEK', 'SGD', 'THB', 'TRY', 'TTD', 'TZS', 'UAH', 'USD', 'UYU', 'UZS', 'ZAR', 'ZMW',
]);

/** Upper-cased, trimmed code when it is an allowed two-decimal ISO 4217 currency, else null. */
export function normalizeStoreCurrency(input: string): string | null {
  const code = input.trim().toUpperCase();
  return TWO_DECIMAL_CURRENCIES.has(code) ? code : null;
}
