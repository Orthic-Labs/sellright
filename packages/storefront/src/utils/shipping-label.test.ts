import { describe, expect, it, vi } from 'vitest';
import { shippingDateText } from './shipping-label';

describe('shipping date presentation', () => {
  it('prefers source copy verbatim without passing it to date formatting', () => {
    const format = vi.fn(() => 'January 1, 2027');
    expect(shippingDateText({ shipDateLabel: '  Fall & <updates>  ', shipDate: '2027-01-01T00:00:00Z' }, format)).toBe('  Fall & <updates>  ');
    expect(format).not.toHaveBeenCalled();
  });
  it('keeps formatted timestamp fallback & absent date behavior', () => {
    const format = vi.fn(() => 'January 1, 2027');
    expect(shippingDateText({ shipDateLabel: '', shipDate: '2027-01-01T00:00:00Z' }, format)).toBe('January 1, 2027');
    expect(format).toHaveBeenCalledWith('2027-01-01T00:00:00Z');
    expect(shippingDateText({ shipDateLabel: null, shipDate: null })).toBeNull();
  });
});
