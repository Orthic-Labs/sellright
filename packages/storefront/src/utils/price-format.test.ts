import { describe, expect, it } from 'vitest';
import { formatPrice, formatShippingPrice } from './price-format';

describe('formatShippingPrice (#401: "Free" vs "$0")', () => {
	it('reads Free for a free shipping line, in every currency', () => {
		expect(formatShippingPrice(0)).toBe('Free');
		expect(formatShippingPrice(0, 'CAD')).toBe('Free');
		expect(formatShippingPrice()).toBe('Free');
	});

	it('prints a paid amount exactly as formatPrice does', () => {
		expect(formatShippingPrice(800)).toBe(formatPrice(800));
		expect(formatShippingPrice(795, 'USD')).toBe('$7.95');
	});
});

describe('formatPrice, product page prices (M-L3)', () => {
	it('keeps whole dollars bare and shows cents when present', () => {
		expect(formatPrice(4000)).toBe('$40');
		expect(formatPrice(1999)).toBe('$19.99');
		expect(formatPrice(3950)).toBe('$39.50');
	});
});
