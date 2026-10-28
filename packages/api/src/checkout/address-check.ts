import { addressFieldErrors, type AddressInput } from './address-rules.js';

export type AddressFieldErrors = Record<string, string>;

/**
 * Server half of #407: the same rules the storefront applies, on canonical addresses
 * ({ fullName, line1, line2, city, province, postalCode, country, phone }).
 * Keys are prefixed with the address kind ("shippingAddress.postalCode") so a client can
 * put each message under the right field. Returns null when every given address is valid;
 * an absent address is not checked (digital orders).
 */
export function addressErrors(addresses: Partial<Record<'shippingAddress' | 'billingAddress', AddressInput | null | undefined>>): AddressFieldErrors | null {
  const out: AddressFieldErrors = {};
  for (const [kind, address] of Object.entries(addresses)) {
    if (!address) continue;
    // An address with no street and no city is a location only (country, maybe a postcode, sent for tax or a
    // shipping quote): check just the fields it carries. Anything with a street or city is a full address.
    const given = (v: unknown) => v != null && String(v).trim() !== '';
    const full = given(address.line1) || given(address.city);
    for (const [field, message] of Object.entries(addressFieldErrors(address))) {
      if (full || given(address[field as keyof AddressInput])) out[`${kind}.${field}`] = message;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** The first message, prefixed by which address it is about, for clients that show one line. */
export function firstAddressError(errors: AddressFieldErrors): { param: string; message: string } {
  const [param, message] = Object.entries(errors)[0]!;
  return { param, message: param.startsWith('billingAddress.') ? `Billing address: ${message}` : message };
}
