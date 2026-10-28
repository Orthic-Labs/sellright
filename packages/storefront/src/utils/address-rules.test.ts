import { describe, expect, it } from 'vitest';
import {
  addressFieldErrors,
  validateAddressLine,
  validateCity,
  validatePersonName,
  validatePhoneLoose,
  validatePostcode,
  validateRegion,
} from './address-rules';
import { validateAddress, validateName, validatePhone, validatePostalCode, validateStateProvince } from './validation';

describe('names (#407)', () => {
  it.each(['José', 'Zoë', 'Müller', "O'Neil", 'O’Neil', 'Jean-Luc', 'St. John', 'Nguyễn', '李', 'Björk Guðmundsdóttir', 'J'])(
    'accepts %s',
    (name) => expect(validatePersonName(name).isValid).toBe(true),
  );
  it.each(['', '   ', 'R2D2', 'a@b', '-Anne', 'x'.repeat(101), 'Bad\u0007Bell'])('rejects %j', (name) => {
    expect(validatePersonName(name).isValid).toBe(false);
  });
  it('trims before checking and names the field in the message', () => {
    expect(validatePersonName('  José  ').isValid).toBe(true);
    expect(validateName('', 'First name')).toEqual({ isValid: false, message: 'First name is required' });
  });
});

describe('address lines and city (#407)', () => {
  it.each(['123 Main St #4', '12 1/2 Oak Ave', '1 Calle Peña', 'Straße 12', 'Flat 3 & 4, Rose Court', '1-2-3 Ginza', '29 Palms Hwy'])(
    'accepts street %s',
    (line) => expect(validateAddress(line, 'Street address').isValid).toBe(true),
  );
  it.each(['Montréal', 'München', 'São Paulo', 'Washington, D.C.', '29 Palms', "L'Aquila"])('accepts city %s', (city) => {
    expect(validateCity(city).isValid).toBe(true);
  });
  it('rejects empty, punctuation-only, control characters and over-length', () => {
    expect(validateAddressLine('', 'Street address')).toEqual({ isValid: false, message: 'Street address is required' });
    expect(validateAddressLine('###', 'Street address').isValid).toBe(false);
    expect(validateAddressLine('1 Main\nSt', 'Street address').isValid).toBe(false);
    expect(validateAddressLine('x'.repeat(201), 'Street address').isValid).toBe(false);
  });
  it('treats line 2 as optional', () => {
    expect(validateAddressLine('', 'Apartment', false).isValid).toBe(true);
  });
});

describe('postcode by country (#407)', () => {
  it.each([
    ['10001', 'US'], ['10001-1234', 'US'], ['902101234', 'US'], ['12345', 'US'],
    ['K1A 0B1', 'CA'], ['k1a0b1', 'CA'],
    ['SW1A 1AA', 'GB'], ['M1 1AE', 'GB'], ['EC1A1BB', 'GB'],
    ['2000', 'AU'], ['400001', 'IN'], ['400 001', 'IN'],
    ['1000-001', 'PT'], ['1012 AB', 'NL'], ['75001', 'FR'],
    ['100-0001', 'JP'], ['SE-123 45', 'SE'],
  ])('accepts %s for %s', (code, country) => expect(validatePostcode(code, country).isValid).toBe(true));

  it.each([['1234', 'US'], ['ABCDE', 'US'], ['123456', 'CA'], ['SW1A', 'GB'], ['20000', 'AU'], ['012345', 'IN'], ['1000001', 'PT']])(
    'rejects %s for %s',
    (code, country) => expect(validatePostcode(code, country).isValid).toBe(false),
  );

  it('is required where countries use one and optional where they do not', () => {
    expect(validatePostalCode('', 'GB')).toEqual({ isValid: false, message: 'Postcode is required' });
    expect(validatePostalCode('', 'IN').isValid).toBe(false);
    expect(validatePostalCode('', 'HK').isValid).toBe(true);
    expect(validatePostalCode('', 'AE').isValid).toBe(true);
    expect(validatePostalCode('', 'IE').isValid).toBe(true);
  });
});

describe('state/province by country (#407)', () => {
  it('is required for US, CA, AU and IN and optional for GB, HK, DE', () => {
    for (const c of ['US', 'CA', 'AU', 'IN']) expect(validateStateProvince('', c).isValid).toBe(false);
    for (const c of ['GB', 'HK', 'DE']) expect(validateStateProvince('', c).isValid).toBe(true);
  });
  it.each([['CA', 'US'], ['california', 'US'], ['DC', 'US'], ['Washington DC', 'US'], ['PR', 'US'], ['AE', 'US'], ['Québec', 'CA'], ['Quebec', 'CA'], ['qc', 'CA'], ['NSW', 'AU'], ['Victoria', 'AU'], ['Maharashtra', 'IN']])(
    'accepts %s for %s',
    (region, country) => expect(validateRegion(region, country).isValid).toBe(true),
  );
  it('rejects a region that is not on the US list', () => {
    expect(validateRegion('Narnia', 'US').isValid).toBe(false);
  });
});

describe('phone (#407)', () => {
  it('is optional for every country', () => {
    for (const c of ['US', 'GB', 'DE', 'HK', 'IN']) expect(validatePhone('', c).isValid).toBe(true);
  });
  it.each(['+44 20 7946 0958', '(212) 555-0123', '020 7946 0958', '+852 2123 4567', '212.555.0123 ext 12'])('accepts %s', (p) => {
    expect(validatePhoneLoose(p).isValid).toBe(true);
  });
  it.each(['call me', '12345', '+1 234 567 890 123 456', 'x'.repeat(40)])('rejects %s', (p) => {
    expect(validatePhoneLoose(p).isValid).toBe(false);
  });
});

describe('whole addresses (#407)', () => {
  it('accepts GB, HK and IN addresses as shoppers type them', () => {
    expect(addressFieldErrors({ fullName: 'Zoë Müller', line1: 'Flat 2, 10 Downing St', city: 'London', postalCode: 'SW1A 2AA', country: 'GB' })).toEqual({});
    expect(addressFieldErrors({ fullName: 'Chan Tai Man', line1: 'Flat 12A, 8/F, 1 Queen’s Rd', city: 'Central', country: 'HK' })).toEqual({});
    expect(addressFieldErrors({ fullName: 'Priya Shah', line1: '12/4 MG Road', city: 'Mumbai', province: 'Maharashtra', postalCode: '400001', country: 'IN' })).toEqual({});
    expect(addressFieldErrors({ fullName: 'José García', line1: '123 Main St #4', city: 'Austin', province: 'TX', postalCode: '78701', country: 'US' })).toEqual({});
  });
  it('returns one message per bad field', () => {
    expect(addressFieldErrors({ line1: '', city: '', country: 'US', postalCode: '1', phone: 'abc' }, { requireName: true })).toEqual({
      fullName: 'Name is required',
      line1: 'Street address is required',
      city: 'City is required',
      province: 'State/Province is required',
      postalCode: 'Please enter a valid ZIP code (e.g. 10001 or 10001-1234)',
      phone: 'Use digits only (spaces, +, - and brackets are fine)',
    });
    expect(addressFieldErrors({ line1: '1 Main St', city: 'X' }).country).toBe('Country is required');
  });
});
