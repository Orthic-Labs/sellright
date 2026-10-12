// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	detach,
	freezeEnabled,
	legacyPriceToNumber,
	projectBlogCard,
	projectFacets,
	projectFeatured,
	projectFormState,
	projectIdentity,
	projectOrder,
	projectPrice,
	projectProductTiles,
	projectQuantityOptions,
	seal,
} from './project';

afterEach(() => vi.unstubAllEnvs());

const identity = {
	storeName: 'S', legalName: 'S LLC', tagline: 't', supportEmail: 'a@b.c', logoText: 'S', logoImageUrl: null, ogImageUrl: '/og.png',
	address: { streetAddress: 'x', addressLocality: 'y', addressRegion: 'z', postalCode: '1', addressCountry: 'US' },
	social: { instagram: 'i' }, colors: {}, fonts: {}, currency: 'USD', locale: 'en-US', siteOrigin: 'https://s.example', published: true, policies: {},
} as never;

describe('projections are detached and frozen in dev/test', () => {
	it('projectIdentity picks the public fields only and freezes the result', () => {
		const p = projectIdentity(identity);
		expect(p).toEqual({ storeName: 'S', legalName: 'S LLC', tagline: 't', supportEmail: 'a@b.c', logoText: 'S', logoImageUrl: null, siteOrigin: 'https://s.example', social: { instagram: 'i' } });
		expect(Object.isFrozen(p)).toBe(true);
		expect(() => { (p as { storeName: string }).storeName = 'X'; }).toThrow(TypeError);
		expect(() => { (p.social as { instagram: string }).instagram = 'X'; }).toThrow(TypeError);
		expect('address' in p).toBe(false);
	});

	it('a write to a projected order throws in test mode and never reaches the source', () => {
		const order = { code: 'A1', state: 'PaymentSettled', grandTotal: 1000, lines: 2, nested: { a: [1, 2, { b: 3 }] } } as never;
		const p = projectOrder(order) as unknown as { code: string; nested: { a: unknown[] } };
		expect(() => { p.code = 'X'; }).toThrow(TypeError);
		expect(() => { p.nested.a.push(4); }).toThrow(TypeError);
		expect((order as { code: string }).code).toBe('A1');
		expect(p).not.toBe(order);
		expect(p.nested).not.toBe((order as { nested: unknown }).nested);
	});

	it('detach drops functions and class instances, so a signal or store cannot ride along', () => {
		class Sig { value = 1; }
		const copy = detach({ a: 1, fn: () => 1, sig: new Sig(), list: [1, new Sig(), 'x'], map: new Map() });
		expect(copy).toEqual({ a: 1, list: [1, undefined, 'x'] });
	});

	it('production: each projection is a fresh unfrozen copy, so a write only touches a discarded copy', () => {
		vi.stubEnv('DEV', false);
		vi.stubEnv('MODE', 'production');
		expect(freezeEnabled()).toBe(false);
		const source = { id: 'f', name: 'F', open: true, values: [{ id: 'v', name: 'V', selected: false }] };
		const first = projectFacets([source]);
		(first[0] as { name: string }).name = 'CHANGED';
		(first[0].values[0] as { selected: boolean }).selected = true;
		const second = projectFacets([source]);
		expect(second[0].name).toBe('F');
		expect(second[0].values[0].selected).toBe(false);
		expect(source.name).toBe('F');
		expect(source.values[0].selected).toBe(false);
		const o1 = seal({ a: { b: 1 } });
		expect(Object.isFrozen(o1)).toBe(false);
	});

	it('dev/test: freezeEnabled is true', () => {
		expect(freezeEnabled()).toBe(true);
	});
});

describe('call-site projections used by the base pages', () => {
	it('projectFacets copies a store field by field', () => {
		const store = { id: '1', name: 'A', open: false, values: [{ id: 'x', name: 'X', selected: true, extra: 'drop' }], other: 1 } as never;
		expect(projectFacets([store])).toEqual([{ id: '1', name: 'A', open: false, values: [{ id: 'x', name: 'X', selected: true }] }]);
	});

	it('legacyPriceToNumber mirrors Price/ProductCard', () => {
		expect(legacyPriceToNumber(500)).toBe(500);
		expect(legacyPriceToNumber({ value: 7 })).toBe(7);
		expect(legacyPriceToNumber({ min: 3, max: 3 })).toBe(3);
		expect(legacyPriceToNumber(null)).toBeNull();
		expect(legacyPriceToNumber('5')).toBeNull();
	});

	it('projectProductTiles keeps the primitive ProductCard props (image from productAsset.preview, price from the legacy union, inStock as given)', () => {
		expect(projectProductTiles([{ slug: 's', productName: 'N', productAsset: { preview: '/a.png' }, priceWithTax: { min: 9, max: 9 }, inStock: false }, { slug: 't', productName: 'M', productAsset: null, priceWithTax: 4 }])).toEqual([
			{ slug: 's', name: 'N', image: '/a.png', price: 9, inStock: false },
			{ slug: 't', name: 'M', image: null, price: 4, inStock: undefined },
		]);
	});

	it('projectFeatured: brand tiles carry no stock fields and are frozen', () => {
		const out = projectFeatured([{ slug: 's', productName: 'N', productAsset: { preview: '/a.png' }, priceWithTax: 100, inStock: true }]);
		expect(out).toEqual([{ slug: 's', name: 'N', href: '/products/s/', image: '/a.png', priceCents: 100, currencyCode: 'USD' }]);
		expect(Object.isFrozen(out)).toBe(true);
		expect('inStock' in out[0]).toBe(false);
	});

	it('projectPrice reproduces the Price props of the base homepage', () => {
		expect(projectPrice({ priceWithTax: 1000, price: 900, customFields: { salePrice: 800, preOrderPrice: null, isPreOrder: false } })).toEqual({ price: 1000, salePrice: 800, preOrderPrice: undefined, isPreOrder: false });
		expect(projectPrice({ price: 900 })).toEqual({ price: 900, salePrice: undefined, preOrderPrice: undefined, isPreOrder: undefined });
	});

	it('projectQuantityOptions matches the cart drawer list', () => {
		expect(projectQuantityOptions(3, false)).toEqual([1, 2, 3]);
		expect(projectQuantityOptions(10, false)).toHaveLength(10);
		expect(projectQuantityOptions(25, false)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, '10+']);
		expect(projectQuantityOptions(12, true)).toHaveLength(12);
	});
});

describe('content projections', () => {
	it('projectFormState maps sending to submitting and hides a stale message', () => {
		expect(projectFormState({ status: 'sending', message: 'old', turnstileRequired: true, turnstileReady: false })).toEqual({ status: 'submitting', message: null, turnstileRequired: true, turnstileReady: false });
		expect(projectFormState({ status: 'error', message: 'bad', turnstileRequired: false, turnstileReady: false }).message).toBe('bad');
	});

	it('projectBlogCard: date falls back to createdAt, readingTime defaults to 1, href is the post path', () => {
		const card = projectBlogCard({ slug: 'p', title: 'T', excerpt: '', featuredImage: { preview: '/i.png' }, publishDate: null, createdAt: '2026-01-02', readingTime: 0, tags: ['a'] });
		expect(card).toEqual({ slug: 'p', title: 'T', excerpt: null, image: '/i.png', publishedAt: '2026-01-02', readingTime: 1, href: '/blog/p/', tags: ['a'] });
		expect(projectBlogCard({ slug: 'p', title: 'T', publishDate: '2026-03-04', createdAt: '2026-01-02', readingTime: 7 }).publishedAt).toBe('2026-03-04');
		expect(projectBlogCard({ slug: 'p', title: 'T' }).publishedAt).toBeNull();
	});
});
