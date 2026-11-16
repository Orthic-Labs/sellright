/**
 * #451: a store may require a phone number on orders shipped abroad (carriers ask for one on customs forms).
 * `config.checkout.phoneRequiredOutside` lists the countries where the phone stays optional; shipping anywhere
 * else needs one. Unset (or empty, or malformed) means phone is optional everywhere.
 */
export function phoneRequiredOutside(config: unknown): string[] | null {
  const raw = (config as { checkout?: { phoneRequiredOutside?: unknown } } | null | undefined)?.checkout?.phoneRequiredOutside;
  if (!Array.isArray(raw)) return null;
  const codes = raw.filter((c): c is string => typeof c === 'string' && /^[A-Za-z]{2}$/.test(c.trim())).map((c) => c.trim().toUpperCase());
  return codes.length ? [...new Set(codes)] : null;
}

/** Whether an order shipped to `country` must carry a phone number under this store's setting. */
export function shippingPhoneRequired(config: unknown, country: unknown): boolean {
  const optionalIn = phoneRequiredOutside(config);
  const c = typeof country === 'string' ? country.trim().toUpperCase() : '';
  return !!optionalIn && /^[A-Z]{2}$/.test(c) && !optionalIn.includes(c);
}

export const PHONE_REQUIRED_MESSAGE = 'Phone number is required for international orders';
