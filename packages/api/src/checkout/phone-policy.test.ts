import { describe, expect, it } from 'vitest';
import { phoneRequiredOutside, shippingPhoneRequired } from './phone-policy.js';

describe('#451 phone required outside the listed countries', () => {
  const config = { checkout: { phoneRequiredOutside: ['us', 'PR', 'PR', 'usa', 7] } };
  it('reads the list, upper-cased, without duplicates or junk', () => {
    expect(phoneRequiredOutside(config)).toEqual(['US', 'PR']);
  });
  it('is off when unset, empty or malformed', () => {
    for (const c of [null, {}, { checkout: {} }, { checkout: { phoneRequiredOutside: [] } }, { checkout: { phoneRequiredOutside: 'US' } }]) {
      expect(phoneRequiredOutside(c)).toBeNull();
      expect(shippingPhoneRequired(c, 'IE')).toBe(false);
    }
  });
  it('requires a phone only for other countries', () => {
    expect(shippingPhoneRequired(config, 'IE')).toBe(true);
    expect(shippingPhoneRequired(config, 'ie')).toBe(true);
    expect(shippingPhoneRequired(config, 'US')).toBe(false);
    expect(shippingPhoneRequired(config, 'pr')).toBe(false);
    expect(shippingPhoneRequired(config, '')).toBe(false);
    expect(shippingPhoneRequired(config, null)).toBe(false);
  });
});
