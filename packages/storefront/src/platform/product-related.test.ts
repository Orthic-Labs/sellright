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
	it('its category by price, the product itself excluded, availability ignored (cards carry none)', () => {
		const r = relatedRow(LIST, 'pocket');
		expect(r.heading).toBe('You may also like');
		expect(r.items.map((i) => i.slug)).toEqual(['fenrir', 'basilisk', 'cerberus']);
		expect(r.items[0]).toEqual({ slug: 'fenrir', name: 'fenrir', href: '/products/fenrir/', image: '/assets/fenrir.jpg', priceCents: 7000 });
		expect(relatedRow(LIST.map((p) => ({ ...p, inStock: !p.inStock })), 'pocket')).toEqual(r);
	});
	it('a sold-out product gets the same row; at most four; untagged products share one category', () => {
		expect(relatedRow(LIST, 'poison').items.map((i) => i.slug)).toEqual(['milk']);
		const many = Array.from({ length: 6 }, (_, k) => ({ ...item(`k${k}`, 'x', 100 * (6 - k), true), tags: [] }) as CatalogListItem);
		expect(relatedRow(many, 'k0').items.map((i) => i.slug)).toEqual(['k5', 'k4', 'k3', 'k2']);
	});
	it('a product alone in its category or unknown: empty', () => {
		expect(relatedRow(LIST, 'tee')).toEqual({ heading: '', items: [] });
		expect(relatedRow(LIST, 'nope')).toEqual({ heading: '', items: [] });
	});
});
