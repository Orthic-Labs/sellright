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
      'shippingAddress.postalCode': 'Please enter a valid ZIP code (e.g. 10001 or 10001-1234)',
      'billingAddress.city': 'City is required',
    });
    expect(firstAddressError({ 'billingAddress.city': 'City is required' })).toEqual({ param: 'billingAddress.city', message: 'Billing address: City is required' });
  });

  it('is looser than the browser: wallet names with & or digits and an abbreviated state pass', () => {
    expect(addressErrors({
      shippingAddress: { fullName: 'AT&T Flat 2B Ltd', line1: '1 Infinite Loop', city: 'Cupertino', province: 'Calif.', postalCode: '95014', country: 'US' },
      billingAddress: { fullName: 'John Smith 3rd', line1: '1 Main St', city: 'Toronto', province: 'Ont', postalCode: 'M5H 2N2', country: 'CA' },
    })).toBeNull();
  });

  it('still refuses what no carrier can use: missing fields, control characters, bad formats', () => {
    expect(addressErrors({ shippingAddress: { fullName: 'A\u0000B', line1: '1 Main St', city: 'Austin', province: '', postalCode: '7870', country: 'US' } })).toEqual({
      'shippingAddress.fullName': "Name contains characters that can't be printed on a label",
      'shippingAddress.province': 'State/Province is required',
      'shippingAddress.postalCode': 'Please enter a valid ZIP code (e.g. 10001 or 10001-1234)',
    });
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
