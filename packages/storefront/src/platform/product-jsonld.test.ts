import { describe, expect, it } from 'vitest';
import { resolveVariant, selectionFromQuery, type ModelProduct } from '~/platform/controllers/product-model';
import { absoluteOn, productGroupSchema, skuStem, withProductFacts } from './product-jsonld';
import type { JsonLdSchema } from '~/types/seo.types';

const ORIGIN = 'https://shop.example';
const model = (): ModelProduct =>
	({
		key: 'short',
		slug: 'tee',
		name: 'Core tee',
		href: '/shop/tee/',
		description: '<p>Soft.</p>',
		images: [{ url: '/assets/a/tee.png', alt: null }],
		groups: [
			{ code: 'color', name: 'Color', values: [{ code: 'midnight-black', name: 'Midnight black' }, { code: 'cloud-white', name: 'Cloud white' }] },
			{ code: 'size', name: 'Size', values: [{ code: 'small', name: 'Small' }] },
		],
		variants: [
			{ sku: 'RH1-01', name: 'x', options: [{ group: 'color', value: 'midnight-black' }, { group: 'size', value: 'small' }], priceCents: 7500, salePriceCents: null, preOrderPriceCents: null, isPreOrder: false, shipDate: null, images: [{ url: '/assets/a/black.png', alt: null }], optionLabel: '' },
			{ sku: 'RH1-02', name: 'y', options: [{ group: 'color', value: 'cloud-white' }, { group: 'size', value: 'small' }], priceCents: 7500, salePriceCents: 6000, preOrderPriceCents: null, isPreOrder: false, shipDate: null, images: [], optionLabel: '' },
		],
		currencyCode: 'USD',
		rating: null,
		productId: null,
	}) as unknown as ModelProduct;

describe('product JSON-LD', () => {
	it('absoluteOn: absolute stays, site-rooted and bare asset paths become absolute', () => {
		expect(absoluteOn(ORIGIN, 'https://cdn.example/x.png')).toBe('https://cdn.example/x.png');
		expect(absoluteOn(ORIGIN, '/assets/x.png')).toBe(`${ORIGIN}/assets/x.png`);
		expect(absoluteOn(ORIGIN, 'uuid/media/x.png')).toBe(`${ORIGIN}/assets/uuid/media/x.png`);
	});

	it('skuStem: the shared stem, or null', () => {
		expect(skuStem(['RH1-01', 'RH1-02'])).toBe('RH1');
		expect(skuStem(['RH1-01', 'RH2-01'])).toBeNull();
		expect(skuStem(['PLAIN'])).toBeNull();
	});

	it('ProductGroup: options, prices, per-variant URLs and images, declared material; offers carry no availability', () => {
		const g = productGroupSchema(model(), { siteOrigin: ORIGIN, brandName: 'Brand', facts: { material: 'Peach-skin' } }) as unknown as Record<string, any>;
		expect(g['@type']).toBe('ProductGroup');
		expect(g.url).toBe(`${ORIGIN}/shop/tee/`);
		expect(g.productGroupID).toBe('RH1');
		expect(g.material).toBe('Peach-skin');
		expect(g.brand).toEqual({ '@type': 'Brand', name: 'Brand' });
		expect(g.variesBy).toEqual(['https://schema.org/color', 'https://schema.org/size']);
		expect(g.hasVariant[0]).toMatchObject({ name: 'Core tee - Midnight black - Small', sku: 'RH1-01', color: 'Midnight black', size: 'Small', url: `${ORIGIN}/shop/tee/?color=midnight-black&size=small`, image: `${ORIGIN}/assets/a/black.png` });
		expect(g.hasVariant[0].offers).toEqual({ '@type': 'Offer', url: `${ORIGIN}/shop/tee/?color=midnight-black&size=small`, price: '75.00', priceCurrency: 'USD', itemCondition: 'https://schema.org/NewCondition' });
		expect(g.hasVariant[1].offers.price).toBe('60.00');
		expect(g.hasVariant[1].image).toBe(`${ORIGIN}/assets/a/tee.png`);
		expect(JSON.stringify(g)).not.toMatch(/availability|InStock|OutOfStock/);
	});

	it('ProductGroup: offer prices follow the effective price rules (pre-order, sale, zero sale)', () => {
		const m = model();
		m.variants[0] = { ...m.variants[0], isPreOrder: true, preOrderPriceCents: 5000, salePriceCents: 4000 };
		m.variants[1] = { ...m.variants[1], salePriceCents: 0 };
		const g = productGroupSchema(m, { siteOrigin: ORIGIN, brandName: 'B' }) as unknown as Record<string, any>;
		expect(g.hasVariant.map((v: any) => v.offers.price)).toEqual(['50.00', '75.00']);
	});

	it('ProductGroup: every variant URL names each option by its group code and resolves back to that variant', () => {
		const m = model();
		m.groups = [
			{ code: 'colour', name: 'Colour', values: [{ code: 'black', name: 'Black' }] },
			{ code: 'fit', name: 'Fit', values: [{ code: 'slim', name: 'Slim' }, { code: 'relaxed', name: 'Relaxed' }] },
		];
		m.variants = [
			{ ...m.variants[0], sku: 'F-1', options: [{ group: 'colour', value: 'black' }, { group: 'fit', value: 'slim' }] },
			{ ...m.variants[1], sku: 'F-2', options: [{ group: 'colour', value: 'black' }, { group: 'fit', value: 'relaxed' }] },
		];
		const g = productGroupSchema(m, { siteOrigin: ORIGIN, brandName: 'B' }) as unknown as Record<string, any>;
		expect(g.hasVariant.map((v: any) => v.url)).toEqual([`${ORIGIN}/shop/tee/?colour=black&fit=slim`, `${ORIGIN}/shop/tee/?colour=black&fit=relaxed`]);
		expect(g.hasVariant[0].color).toBe('Black');
		for (const v of g.hasVariant) {
			const selected = selectionFromQuery(m, new URL(v.url).searchParams);
			expect(resolveVariant(m, selected)?.sku).toBe(v.sku);
		}
	});

	it('ProductGroup without variant URLs (no product view to preselect): every variant names the product URL', () => {
		const g = productGroupSchema(model(), { siteOrigin: ORIGIN, brandName: 'B', variantUrls: false }) as unknown as Record<string, any>;
		expect(g.hasVariant.map((v: any) => v.url)).toEqual([`${ORIGIN}/shop/tee/`, `${ORIGIN}/shop/tee/`]);
		expect(g.hasVariant[0].offers.url).toBe(`${ORIGIN}/shop/tee/`);
	});

	it('PDP facts: material, colours, sizes, brand, condition, plain description, absolute images; offers untouched', () => {
		const offers = { '@type': 'Offer', price: '75.00', availability: 'https://schema.org/OutOfStock' };
		const api = { '@type': 'Product', name: 'Core tee', description: '<p>Soft &amp; light.</p>', image: ['uuid/media/a.png', '/assets/b.png'], offers } as unknown as JsonLdSchema;
		const s = withProductFacts(api, model(), { siteOrigin: ORIGIN, brandName: 'Brand', facts: { material: 'Peach-skin' } }) as unknown as Record<string, any>;
		expect(s.description).toBe('Soft & light.');
		expect(s.image).toEqual([`${ORIGIN}/assets/uuid/media/a.png`, `${ORIGIN}/assets/b.png`]);
		expect(s.material).toBe('Peach-skin');
		expect(s.color).toEqual(['Midnight black', 'Cloud white']);
		expect(s.size).toEqual(['Small']);
		expect(s.brand).toEqual({ '@type': 'Brand', name: 'Brand' });
		expect(s.itemCondition).toBe('https://schema.org/NewCondition');
		expect(s.offers).toBe(offers);
		const kept = withProductFacts({ ...api, brand: { '@type': 'Brand', name: 'API' } } as unknown as JsonLdSchema, model(), { siteOrigin: ORIGIN, brandName: 'Brand' }) as unknown as Record<string, any>;
		expect(kept.brand.name).toBe('API');
		expect(kept.material).toBeUndefined();
	});
});
