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

import { LISTING_MAX_PAGES, LISTING_PAGE, readLiveListing } from './listing-availability';

describe('readLiveListing (every page, fail closed)', () => {
	const catalog = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `p${i}`, inStock: true }));
	it('reads every page of a catalog larger than one page, so an in-stock product past the first page stays in stock', async () => {
		const all = catalog(1203);
		const calls: number[] = [];
		const live = await readLiveListing(async ({ take, skip }) => {
			calls.push(skip);
			return { items: all.slice(skip, skip + take), total: all.length };
		});
		expect(calls).toEqual([0, LISTING_PAGE, 2 * LISTING_PAGE]);
		expect(live?.items).toHaveLength(1203);
		expect(liveListingAvailability(['p0', 'p1202'], live)).toEqual({ p0: true, p1202: true });
	});
	it('a failed page or a catalog past the ceiling is a failed read (all out of stock)', async () => {
		let n = 0;
		expect(await readLiveListing(async () => { if (n++ === 1) throw new Error('500'); return { items: catalog(LISTING_PAGE), total: 2000 }; })).toBeNull();
		const huge = (LISTING_MAX_PAGES + 1) * LISTING_PAGE;
		expect(await readLiveListing(async ({ take }) => ({ items: catalog(take), total: huge }))).toBeNull();
	});
});
