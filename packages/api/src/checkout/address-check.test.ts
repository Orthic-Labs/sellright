import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addressErrors, firstAddressError } from './address-check.js';

describe('address rules parity (#407)', () => {
  it('the API copy of address-rules.ts is byte-identical to the storefront copy', () => {
    const api = readFileSync(fileURLToPath(new URL('./address-rules.ts', import.meta.url)), 'utf8');
    const storefront = readFileSync(fileURLToPath(new URL('../../../storefront/src/utils/address-rules.ts', import.meta.url)), 'utf8');
    expect(api).toBe(storefront);
  });
});

describe('addressErrors (#407)', () => {
  it('accepts real addresses the old storefront rules refused', () => {
    expect(addressErrors({
      shippingAddress: { fullName: 'José Müller', line1: '123 Main St #4', city: 'Montréal', province: 'QC', postalCode: 'H2X 1Y4', country: 'CA' },
      billingAddress: { fullName: "Zoë O'Neil", line1: '12 1/2 Oak Ave', city: 'London', postalCode: 'SW1A 1AA', country: 'GB' },
    })).toBeNull();
    expect(addressErrors({ shippingAddress: { fullName: 'Chan Tai Man', line1: 'Flat 12A, 1 Queen’s Rd', city: 'Central', country: 'HK' } })).toBeNull();
  });

  it('prefixes each field with its address kind', () => {
    const errors = addressErrors({
      shippingAddress: { fullName: 'R2D2', line1: '1 Main St', city: 'Austin', province: 'TX', postalCode: '7870', country: 'US' },
      billingAddress: { line1: '1 Main St', city: '', country: 'GB', postalCode: 'SW1A 1AA' },
    });
    expect(errors).toEqual({
      'shippingAddress.fullName': 'Name can use letters, spaces, hyphens, apostrophes and periods',
      'shippingAddress.postalCode': 'Please enter a valid ZIP code (e.g. 10001 or 10001-1234)',
      'billingAddress.city': 'City is required',
    });
    expect(firstAddressError({ 'billingAddress.city': 'City is required' })).toEqual({ param: 'billingAddress.city', message: 'Billing address: City is required' });
  });

  it('checks a location-only address (no street, no city) on the fields it carries', () => {
    expect(addressErrors({ shippingAddress: { country: 'US' } })).toBeNull();
    expect(addressErrors({ shippingAddress: { country: 'US', postalCode: 'nope!' } })).toEqual({
      'shippingAddress.postalCode': 'Please enter a valid ZIP code (e.g. 10001 or 10001-1234)',
    });
  });

  it('skips absent addresses', () => {
    expect(addressErrors({ shippingAddress: null, billingAddress: undefined })).toBeNull();
  });
});
