import { describe, expect, it } from 'vitest';
import { renamedBlogPath } from './blog-redirects';

describe('renamedBlogPath', () => {
	it('maps each of the five retired slugs to its live successor', () => {
		expect(renamedBlogPath('knife-carry-laws-by-state')).toBe('/blog/knife-carry-laws-by-state-2026/');
		expect(renamedBlogPath('d2-vs-14c28n-s35vn')).toBe('/blog/d2-vs-14c28n-vs-s35vn/');
		expect(renamedBlogPath('best-edc-knives-under-100-in-2026')).toBe('/blog/best-edc-knives-under-100/');
		expect(renamedBlogPath('why-we-chose-14c28n-steel-for-edc')).toBe('/blog/why-we-chose-14c28n/');
		expect(renamedBlogPath('knife-lock-types-explained')).toBe('/blog/knife-lock-types-comparison/');
	});

	it('leaves live slugs, unknown slugs and object-prototype names alone', () => {
		expect(renamedBlogPath('knife-carry-laws-by-state-2026')).toBeNull();
		expect(renamedBlogPath('something-else')).toBeNull();
		expect(renamedBlogPath('constructor')).toBeNull();
		expect(renamedBlogPath('__proto__')).toBeNull();
		expect(renamedBlogPath(undefined)).toBeNull();
	});
});
