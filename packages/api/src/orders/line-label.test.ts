import { describe, expect, it } from 'vitest';
import { orderLineLabel, variantLabel } from './line-label.js';

describe('orderLineLabel (#346)', () => {
  it('prefixes the product and joins options with a middle dot', () => {
    expect(orderLineLabel({ productName: 'Short Sleeve Button-Up Shirt', variantName: 'Medium - Midnight black' }))
      .toBe('Short Sleeve Button-Up Shirt · Medium · Midnight black');
  });
  it('normalises loose option separators but keeps hyphens inside words', () => {
    expect(orderLineLabel({ productName: 'Monsuta Bead', variantName: 'Zirconium- Black - Polished' })).toBe('Monsuta Bead · Zirconium · Black · Polished');
    expect(variantLabel({ productName: 'Shirt', variantName: 'Button-Up' })).toBe('Button-Up');
  });
  it('shows a single-variant product once', () => {
    expect(orderLineLabel({ productName: 'Poison bead', variantName: 'Poison bead' })).toBe('Poison bead');
    expect(orderLineLabel({ productName: 'Poison bead', variantName: '' })).toBe('Poison bead');
  });
  it('keeps a variant name that already names the product as it is', () => {
    expect(orderLineLabel({ productName: 'Necro bead', variantName: 'Necro bead - Ultem' })).toBe('Necro bead - Ultem');
    expect(orderLineLabel({ productName: 'Widget', variantName: 'Widget One' })).toBe('Widget One');
    expect(variantLabel({ productName: 'Necro bead', variantName: 'Necro bead - Ultem' })).toBe('Ultem');
  });
  it('leaves lines without a product snapshot as they are (imported history)', () => {
    expect(orderLineLabel({ productName: null, variantName: 'Djinn - Black G10, D2' })).toBe('Djinn - Black G10, D2');
    expect(orderLineLabel({ variantName: 'Retained' })).toBe('Retained');
  });
});
