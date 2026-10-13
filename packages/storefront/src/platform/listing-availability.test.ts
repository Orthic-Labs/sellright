// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { liveListingAvailability } from './listing-availability';

describe('liveListingAvailability (fail closed)', () => {
	it('only an explicit live inStock === true is in stock; omitted products and malformed rows are out of stock', () => {
		expect(liveListingAvailability(['a', 'b', 'c', 'd'], { items: [{ slug: 'a', inStock: true }, { slug: 'b', inStock: false }, { slug: 'd', inStock: 'yes' }] })).toEqual({ a: true, b: false, c: false, d: false });
	});
	it('a failed read marks every listed product out of stock', () => {
		expect(liveListingAvailability(['a', 'b'], null)).toEqual({ a: false, b: false });
	});
	it('a live item that is not listed is ignored', () => {
		expect(liveListingAvailability(['a'], { items: [{ slug: 'z', inStock: true }] })).toEqual({ a: false });
	});
});
