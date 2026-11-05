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
