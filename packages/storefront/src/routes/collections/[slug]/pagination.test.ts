import { describe, expect, it } from 'vitest';

import { COLLECTION_PAGE_SIZE, collectionPageCount, collectionPageParam } from './pagination';

describe('V21 collection pagination', () => {
	it('parses ?page strictly: absent is 1, malformed or out of range is a 404', () => {
		expect(collectionPageParam(null)).toBe(1);
		expect(collectionPageParam('2')).toBe(2);
		for (const bad of ['0', '-1', '1.5', 'abc', '', '01', '99999999']) expect(collectionPageParam(bad), bad).toBeNull();
	});
	it('counts pages beyond the first 60 products', () => {
		expect(COLLECTION_PAGE_SIZE).toBe(60);
		expect(collectionPageCount(0, 60)).toBe(1);
		expect(collectionPageCount(60, 60)).toBe(1);
		expect(collectionPageCount(61, 60)).toBe(2);
		expect(collectionPageCount(250, 60)).toBe(5);
	});
});
