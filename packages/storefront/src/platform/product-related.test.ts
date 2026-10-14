import { describe, expect, it } from 'vitest';
import { relatedRow } from './product-related-model';
import type { CatalogListItem } from '~/sellright/types/catalog';

const item = (slug: string, tag: string, price: number, inStock: boolean) => ({ slug, name: slug, status: 'active', inStock, tags: [tag], minPrice: price, pricingVariant: null, image: `/assets/${slug}.jpg` }) as unknown as CatalogListItem;
const LIST = [
	item('pocket', 'fixed blades', 4000, true),
	item('basilisk', 'fixed blades', 7500, false),
	item('cerberus', 'fixed blades', 7500, false),
	item('fenrir', 'fixed blades', 7000, true),
	item('milk', 'edc', 1500, true),
	item('poison', 'edc', 1500, false),
	item('tee', 'apparel', 3000, true),
];

describe('relatedRow', () => {
	it('an in-stock product: its category, in-stock first then by price, the product itself excluded', () => {
		const r = relatedRow(LIST, 'pocket');
		expect(r.heading).toBe('You may also like');
		expect(r.items.map((i) => i.slug)).toEqual(['fenrir', 'basilisk', 'cerberus']);
		expect(r.items[0]).toMatchObject({ href: '/products/fenrir/', priceCents: 7000, inStock: true });
	});
	it('a sold-out product: in-stock products, its category first, under "In stock now"', () => {
		const r = relatedRow(LIST, 'poison');
		expect(r.heading).toBe('In stock now');
		expect(r.items.map((i) => i.slug)).toEqual(['milk', 'tee', 'pocket', 'fenrir']);
	});
	it('nothing in stock: the category; an unknown product: empty', () => {
		const none = LIST.map((p) => ({ ...p, inStock: false }));
		expect(relatedRow(none, 'poison')).toEqual({ heading: 'You may also like', items: [expect.objectContaining({ slug: 'milk' })] });
		expect(relatedRow(LIST, 'nope')).toEqual({ heading: '', items: [] });
	});
});
