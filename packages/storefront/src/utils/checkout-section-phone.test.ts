import { describe, expect, it } from 'vitest';
import { phoneRequiredFor, validateCustomerSection } from './checkout-section-validation';

describe('#451 phone required for international orders', () => {
  const customer = { firstName: 'Ada', lastName: 'Lovelace', emailAddress: 'ada@example.com', phoneNumber: '' };
  it('follows the store list', () => {
    expect(phoneRequiredFor('IE', ['US', 'PR'])).toBe(true);
    expect(phoneRequiredFor('us', ['US', 'PR'])).toBe(false);
    expect(phoneRequiredFor('IE', null)).toBe(false);
    expect(phoneRequiredFor('IE', [])).toBe(false);
    expect(phoneRequiredFor('', ['US'])).toBe(false);
  });
  it('blocks an empty phone only when required', () => {
    expect(validateCustomerSection(customer, 'IE').isValid).toBe(true);
    const required = validateCustomerSection(customer, 'IE', true);
    expect(required.isValid).toBe(false);
    expect(required.errors.phone).toBe('Phone number is required');
    expect(validateCustomerSection({ ...customer, phoneNumber: '+353 1 234 5678' }, 'IE', true).isValid).toBe(true);
  });
});
