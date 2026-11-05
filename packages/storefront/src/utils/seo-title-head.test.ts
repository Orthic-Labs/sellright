import { describe, expect, it } from 'vitest';
import { createSEOHead } from './seo';
import { MAX_TITLE_LENGTH } from './seo-title';

const identity = { storeName: 'Damned Designs', siteOrigin: 'https://damneddesigns.com', ogImageUrl: '/og.png' } as never;
type Head = { title?: string; meta?: { property?: string; content?: string }[] };
const headOf = (title: string) => createSEOHead({ title, description: 'd', identity }) as unknown as Head;
const titleOf = (title: string) => headOf(title).title as string;

describe('createSEOHead title length (#408 items 5 and 9)', () => {
	it('keeps the brand suffix when the title fits', () => {
		expect(titleOf('Shop All Products')).toBe('Shop All Products | Damned Designs');
	});

	it('drops the suffix instead of exceeding 60 characters', () => {
		const t = titleOf('D2 vs 14C28N vs S35VN: Which Knife Steel Wins?');
		expect(t).toBe('D2 vs 14C28N vs S35VN: Which Knife Steel Wins?');
		expect(t.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
	});

	it('cuts an over-long title at a word and leaves og:title untouched', () => {
		const long = 'Machined Metal Fidget Toy for Adults: The Complete Buyer Guide to Finding the Best One';
		const head = headOf(long);
		expect((head.title as string).length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
		expect(head.title as string).toMatch(/\u2026$/);
		expect(head.meta?.find((m) => m.property === 'og:title')?.content).toBe(long);
	});
});
