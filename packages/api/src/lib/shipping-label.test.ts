import { describe, expect, it } from 'vitest';
import { shippingLabel, variantShippingLabel } from './shipping-label.js';

describe('shipping display labels', () => {
  it.each(['Ships late fall', '2027-01-01', '  Été & <updates>  ', ' '])('preserves %j exactly', (label) => {
    expect(shippingLabel(label)).toBe(label);
    expect(variantShippingLabel({ shipDateLabel: label, other: true })).toBe(label);
  });
  it.each([null, undefined, '', 1, false, [], {}, { shipDateLabel: 1 }])('does not coerce %j into shipping copy', (value) => {
    expect(shippingLabel(value)).toBeNull();
    expect(variantShippingLabel(value)).toBeNull();
  });
});
