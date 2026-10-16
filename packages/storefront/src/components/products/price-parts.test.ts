import { describe, expect, it } from 'vitest';
import { priceParts } from './price-parts';

describe('priceParts', () => {
	it('plain price with a higher maximum shows a range', () => {
		expect(priceParts({ regularCents: 800, maxPrice: 1500 })).toEqual({ liveCents: 800, strikeCents: null, rangeMaxCents: 1500 });
	});
	it('an applicable sale or pre-order price never shows a range, even when it equals the minimum (snapshot prices)', () => {
		expect(priceParts({ regularCents: 800, salePrice: 800, maxPrice: 1500 })).toEqual({ liveCents: 800, strikeCents: null, rangeMaxCents: null });
		expect(priceParts({ regularCents: 800, preOrderPrice: 800, isPreOrder: true, maxPrice: 1500 })).toEqual({ liveCents: 800, strikeCents: null, rangeMaxCents: null });
		expect(priceParts({ regularCents: 1000, salePrice: 800, maxPrice: 1500 })).toEqual({ liveCents: 800, strikeCents: 1000, rangeMaxCents: null });
	});
	it('no range when the maximum is absent or not above the price', () => {
		expect(priceParts({ regularCents: 800 }).rangeMaxCents).toBeNull();
		expect(priceParts({ regularCents: 800, maxPrice: 800 }).rangeMaxCents).toBeNull();
	});
});
