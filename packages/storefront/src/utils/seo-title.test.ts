import { describe, expect, it } from 'vitest';
import { MAX_TITLE_LENGTH, fitTitle, truncateAtWord } from './seo-title';

describe('truncateAtWord', () => {
	it('leaves a title that fits alone', () => {
		expect(truncateAtWord('Shop All Products')).toBe('Shop All Products');
	});

	it('cuts at a word boundary and ends with an ellipsis, within the limit', () => {
		const long = 'D2 vs 14C28N vs S35VN: Which Knife Steel Holds an Edge Longest in Daily Carry';
		const out = truncateAtWord(long);
		expect(out.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
		expect(out.endsWith('…')).toBe(true);
		const kept = out.slice(0, -1);
		expect(long.startsWith(kept)).toBe(true);
		expect(long[kept.length]).toBe(' '); // cut fell on a word boundary, not inside a word
	});

	it('drops a dangling separator before the ellipsis', () => {
		const out = truncateAtWord('Alpha beta gamma delta - epsilon zeta eta theta iota kappa lambda mu', 30);
		expect(out).not.toMatch(/[-,;:|&]…$/);
		expect(out.length).toBeLessThanOrEqual(30);
	});

	it('only mid-cuts a single word that is longer than the limit', () => {
		const out = truncateAtWord('x'.repeat(80));
		expect(out.length).toBe(MAX_TITLE_LENGTH);
		expect(out.endsWith('…')).toBe(true);
	});
});

describe('fitTitle', () => {
	const store = 'Damned Designs';

	it('adds the brand suffix when it fits', () => {
		expect(fitTitle('Shop All Products', store)).toBe('Shop All Products | Damned Designs');
	});

	it('allows exactly the limit', () => {
		const base = 'a'.repeat(MAX_TITLE_LENGTH - ` | ${store}`.length);
		const out = fitTitle(base, store);
		expect(out).toBe(`${base} | ${store}`);
		expect(out.length).toBe(MAX_TITLE_LENGTH);
	});

	it('drops the brand suffix, keeping the whole title, when the suffix would exceed 60', () => {
		const title = 'D2 vs 14C28N vs S35VN: Which Knife Steel Wins?'; // 46 chars; + suffix = 63
		expect(`${title} | ${store}`.length).toBeGreaterThan(MAX_TITLE_LENGTH);
		expect(fitTitle(title, store)).toBe(title);
	});

	it('shortens at a word when the title alone is still too long', () => {
		const title = 'Machined Metal Fidget Toy for Adults: The Complete Buyer Guide to Finding the Best One';
		const out = fitTitle(title, store);
		expect(out.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
		expect(out).not.toContain('| Damned');
		expect(out.endsWith('…')).toBe(true);
		expect(title.startsWith(out.slice(0, -1))).toBe(true);
	});

	it('does not suffix a title that already is, or ends with, the store name', () => {
		expect(fitTitle(store, store)).toBe(store);
		expect(fitTitle(`Journal | ${store}`, store)).toBe(`Journal | ${store}`);
	});

	it('re-fits a title that carries the suffix but is too long (suffix dropped)', () => {
		const base = 'A Very Long Post Title About Knife Locks And How They Work Today';
		const out = fitTitle(`${base} | ${store}`, store);
		expect(out.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
		expect(out).not.toContain('Damned Designs');
	});

	it('never returns more than the limit', () => {
		for (const n of [5, 20, 40, 52, 58, 60, 61, 90, 200]) {
			const t = Array.from({ length: n }, (_, i) => `w${i}`).join(' ').slice(0, n);
			expect(fitTitle(t, store).length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
		}
	});
});
