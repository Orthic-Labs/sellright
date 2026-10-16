import { describe, expect, it } from 'vitest';
import { buildMethodPayload, calculatorFromForm, emptyForm, formFromMethod, parseCountries, summarizeCalculator, validateForm } from './shipping-method';

const free = { name: 'Free', code: 'free', enabled: true, calculator: { flat: 0, min: 10000, countries: ['US', 'PR'], exclude: false, requireCountry: true, subtotalBasis: 'discounted_with_tax', weird: 1 } };

describe('shipping method form', () => {
  it('round-trips an imported method without losing fields', () => {
    const f = formFromMethod(free);
    expect(f).toMatchObject({ rate: '0.00', min: '100.00', max: '', basis: 'discounted_with_tax', countryMode: 'only', countries: 'US, PR', requireCountry: true });
    expect(calculatorFromForm(f, free.calculator)).toEqual(free.calculator);
  });
  it('edits the free-shipping threshold from $100 to $120', () => {
    const f = { ...formFromMethod(free), min: '120' };
    expect(calculatorFromForm(f, free.calculator).min).toBe(12000);
  });
  it('removes cleared bounds and switches country mode', () => {
    const f = { ...formFromMethod(free), min: '', countryMode: 'except' as const, countries: 'us, ca' };
    const c = calculatorFromForm(f, free.calculator);
    expect(c.min).toBeUndefined();
    expect(c).toMatchObject({ countries: ['US', 'CA'], exclude: true });
    const all = calculatorFromForm({ ...f, countryMode: 'all' }, c);
    expect('countries' in all || 'exclude' in all).toBe(false);
  });
  it('validates', () => {
    expect(validateForm(emptyForm())).toEqual(['Name is required.', 'Code is required.']);
    const base = { ...emptyForm(), name: 'n', code: 'c' };
    expect(validateForm({ ...base, min: '50', max: '10' })).toContain('Minimum subtotal cannot be higher than the maximum.');
    expect(validateForm({ ...base, countryMode: 'only', countries: 'USA' }).join(' ')).toMatch(/2-letter/);
    expect(validateForm({ ...base, countryMode: 'only', countries: '' }).join(' ')).toMatch(/at least one country/);
    expect(validateForm({ ...base, rate: 'abc' }).join(' ')).toMatch(/Rate/);
    expect(validateForm({ ...base, countryMode: 'only', countries: 'us, pr' })).toEqual([]);
  });
  it('builds the PATCH payload', () => {
    expect(buildMethodPayload({ ...emptyForm(), name: ' Std ', code: 'std', rate: '8' })).toEqual({ name: 'Std', code: 'std', enabled: true, calculator: { flat: 800, subtotalBasis: 'pre_discount' } });
  });
  it('parses country lists', () => { expect(parseCountries('us, ca;PR  us')).toEqual(['US', 'CA', 'PR']); });
});

describe('summarizeCalculator', () => {
  it('writes plain language', () => {
    expect(summarizeCalculator({ flat: 0, min: 10000, countries: ['US', 'PR'], subtotalBasis: 'discounted_with_tax' }))
      .toBe('Free shipping · when the subtotal after discounts, including tax is $100.00 or more · to United States and Puerto Rico only');
    expect(summarizeCalculator({ flat: 800, max: 9999 })).toBe('$8.00 flat rate · when the subtotal before discounts is up to $99.99 · to every country');
    expect(summarizeCalculator({ flat: 2500, countries: ['US', 'PR'], exclude: true, requireCountry: true })).toBe('$25.00 flat rate · everywhere except United States and Puerto Rico · (needs a destination country)');
    expect(summarizeCalculator({ flat: 0, min: 100, max: 500 })).toContain('$1.00 to $5.00 (both included)');
  });
});
