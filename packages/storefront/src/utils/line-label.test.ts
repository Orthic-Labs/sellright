import { describe, expect, it } from 'vitest';
import { normalizeOptionSeparators, orderLineLabel, variantLabel } from './line-label';

describe('order line label (#346)', () => {
	it('names the product, then the variant options', () => {
		expect(orderLineLabel({ productName: 'Short Sleeve Button-Up Shirt', variantName: 'Medium - Midnight black' })).toBe('Short Sleeve Button-Up Shirt · Medium · Midnight black');
		expect(variantLabel({ productName: 'Short Sleeve Button-Up Shirt', variantName: 'Medium - Midnight black' })).toBe('Medium · Midnight black');
	});
	it('shows a single-variant product once and strips a repeated product prefix', () => {
		expect(orderLineLabel({ productName: 'Poison bead', variantName: 'Poison bead' })).toBe('Poison bead');
		expect(variantLabel({ productName: 'Studio Notebook', variantName: 'Studio Notebook / Sage' })).toBe('Sage');
	});
	it('keeps lines without a product snapshot as they are', () => {
		expect(orderLineLabel({ productName: null, variantName: 'Djinn - Black G10, D2' })).toBe('Djinn - Black G10, D2');
	});
});

describe('cart line option separator (#401)', () => {
	it('shows the add path and the server name the same way', () => {
		expect(normalizeOptionSeparators('Small / Storm grey')).toBe('Small / Storm grey');
		expect(normalizeOptionSeparators('Small - Storm grey')).toBe('Small / Storm grey');
		expect(normalizeOptionSeparators('Medium - Midnight black - Long')).toBe('Medium / Midnight black / Long');
	});

	it('keeps a hyphen inside a word', () => {
		expect(normalizeOptionSeparators('Button-Up - Navy')).toBe('Button-Up / Navy');
		expect(normalizeOptionSeparators('Navy')).toBe('Navy');
	});
});
