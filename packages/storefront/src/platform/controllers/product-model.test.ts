// @vitest-environment node
// Brand views PR2 §5: the pure product model. Fixtures use catalog option ids that differ from the display names (review round 1).
import { describe, expect, it } from 'vitest';
import type { CatalogProduct } from '~/sellright/types/catalog';
import {
	addResultFrom,
	buildModelProduct,
	computePurchase,
	keepSelection,
	maxQuantityFor,
	productAvailability,
	projectViewProduct,
	resolveVariant,
	selectionFromQuery,
	slugCode,
	stockFromResponse,
	valueAvailability,
	variantAvailability,
	type ProductStock,
} from './product-model';

const opt = (id: string, name: string, groupId: string, group: string, position: number, groupPosition: number) => ({
	id, code: id, name, position, group: { id: groupId, code: groupId, name: group, position: groupPosition },
});
const variant = (sku: string, size: [string, string], color: [string, string], over: Partial<CatalogProduct['variants'][number]> = {}) => ({
	id: sku, sku, name: `Shirt ${size[1]} ${color[1]}`, price: 7500, salePrice: null, preOrderPrice: null, shipDate: null, compareAtPrice: null,
	isPreOrder: false, enabled: true, fulfillmentType: 'physical' as const, appKey: null, inStock: false, availableQuantity: 0,
	options: [opt(size[0], size[1], 'g-41', 'Size', size[0] === 'o-1' ? 0 : size[0] === 'o-2' ? 1 : 2, 0), opt(color[0], color[1], 'g-77', 'Color', color[0] === 'o-9' ? 0 : 1, 1)],
	assets: [{ preview: `/assets/${sku}.jpg` }],
	...over,
});
const PRODUCT = {
	slug: 'shortsleeveshirt', name: 'Core Short Sleeve Shirt', description: '<p>Soft.</p><script>x()</script>', tags: [], status: 'active', seoTitle: null, seoDescription: null,
	currency: 'USD', images: ['/assets/a.jpg'],
	variants: [
		variant('RH-S-BLK', ['o-1', 'Small'], ['o-9', 'Midnight Black']),
		variant('RH-M-BLK', ['o-2', 'Medium'], ['o-9', 'Midnight Black']),
		variant('RH-M-GRN', ['o-2', 'Medium'], ['o-8', 'Forest Green'], { isPreOrder: true }),
	],
} as unknown as CatalogProduct;
const model = buildModelProduct(PRODUCT, { key: 'short', href: '/shop/shortsleeveshirt/', rating: null, productId: 'p1' });
const ready = (bySku: ProductStock['bySku']): ProductStock => ({ status: 'ready', bySku });

describe('model', () => {
	it('codes are slugs of the names, never the catalog ids; groups and values keep the merchant order', () => {
		expect(model.groups.map((g) => g.code)).toEqual(['size', 'color']);
		expect(model.groups[0].values.map((v) => v.code)).toEqual(['small', 'medium']);
		expect(model.groups[1].values.map((v) => v.code)).toEqual(['midnight-black', 'forest-green']);
		expect(model.variants[2].options).toEqual([{ group: 'size', value: 'medium' }, { group: 'color', value: 'forest-green' }]);
		expect(slugCode('  Midnight   Black ')).toBe('midnight-black');
		expect(model.description.html).not.toContain('script');
	});

	it('the model carries no stock field', () => {
		expect(JSON.stringify(model)).not.toMatch(/inStock|availableQuantity/);
	});

	it('resolves a complete selection by codes only', () => {
		expect(resolveVariant(model, ['medium', 'forest-green'])?.sku).toBe('RH-M-GRN');
		expect(resolveVariant(model, ['small', 'forest-green'])).toBeNull();
		expect(resolveVariant(model, ['medium', null])).toBeNull();
		expect(resolveVariant(model, ['o-2', 'o-8'])).toBeNull(); // catalog ids are not codes
	});

	it('deep links preselect by group code and value slug; unknown params and values are ignored', () => {
		const q = new URLSearchParams('size=Medium&color=forest-green&style=long&colour=x');
		expect(selectionFromQuery(model, q)).toEqual(['medium', 'forest-green']);
		expect(selectionFromQuery(model, new URLSearchParams('size=xxl'))).toEqual([null, null]);
	});
});

describe('availability (LOCKED stock rule)', () => {
	it('unchecked, loading and error never read as in stock', () => {
		for (const status of ['unchecked', 'loading', 'error'] as const) {
			const s: ProductStock = { status, bySku: { 'RH-S-BLK': { inStock: true, availableQuantity: 5 } } };
			expect(variantAvailability(s, 'RH-S-BLK')).toBe(status);
			expect(productAvailability(model, s)).toBe(status);
		}
		expect(variantAvailability(undefined, 'RH-S-BLK')).toBe('unchecked');
	});

	it('a SKU absent from the response, a 404 and a non-true inStock are out of stock', () => {
		const s = stockFromResponse({ slug: 'x', variants: [{ sku: 'RH-S-BLK', inStock: true, availableQuantity: 3 }, { sku: 'RH-M-BLK', inStock: 'yes', availableQuantity: 3 }] } as never);
		expect(variantAvailability(s, 'RH-S-BLK')).toBe('in-stock');
		expect(variantAvailability(s, 'RH-M-BLK')).toBe('out-of-stock');
		expect(variantAvailability(s, 'RH-M-GRN')).toBe('out-of-stock');
		expect(productAvailability(model, stockFromResponse(null))).toBe('out-of-stock');
	});

	it('a malformed availableQuantity fails the SKU closed (not in stock, not purchasable); null is uncapped', () => {
		const bad = [-1, Number.NaN, 1.5, '3', undefined, Infinity];
		const s = stockFromResponse({ variants: [...bad.map((q, i) => ({ sku: `B${i}`, inStock: true, availableQuantity: q })), { sku: 'U', inStock: true, availableQuantity: null }, { sku: 'N', inStock: true, availableQuantity: 2 }] } as never);
		bad.forEach((_, i) => {
			expect(s.bySku[`B${i}`]).toEqual({ inStock: false, availableQuantity: 0 });
			expect(variantAvailability(s, `B${i}`)).toBe('out-of-stock');
		});
		expect(s.bySku.U).toEqual({ inStock: true, availableQuantity: null });
		expect(s.bySku.N).toEqual({ inStock: true, availableQuantity: 2 });
		const fractional = stockFromResponse({ variants: [{ sku: 'RH-M-BLK', inStock: true, availableQuantity: 1.5 }] } as never);
		const p = computePurchase({ model, stock: fractional, selected: ['medium', 'midnight-black'], quantity: 1, consent: false, adding: false, last: null, inCart: {} });
		expect(p.purchase).toMatchObject({ eligible: false, reason: 'out-of-stock' });
	});

	it('a stale pre-order flag never makes an explicitly out-of-stock SKU available or purchasable', () => {
		const s = ready({ 'RH-M-GRN': { inStock: false, availableQuantity: 0 } });
		expect(variantAvailability(s, 'RH-M-GRN')).toBe('out-of-stock');
		const p = computePurchase({ model, stock: s, selected: ['medium', 'forest-green'], quantity: 1, consent: true, adding: false, last: null, inCart: {} });
		expect(p.purchase).toMatchObject({ eligible: false, reason: 'out-of-stock' });
		expect(p.selection.preOrderConsent).toBe(false);
	});

	it('a value is available when any variant with it and the other selected values is in stock', () => {
		const s = ready({ 'RH-S-BLK': { inStock: true, availableQuantity: 1 } });
		expect(valueAvailability(model, s, [null, null], 0, 'small')).toBe('in-stock');
		expect(valueAvailability(model, s, [null, null], 0, 'medium')).toBe('out-of-stock');
		expect(valueAvailability(model, s, ['medium', null], 1, 'midnight-black')).toBe('out-of-stock');
		const view = projectViewProduct(model, s, ['small', null]);
		expect(view.availability).toBe('in-stock');
		expect(view.optionGroups[1].values.find((v) => v.code === 'midnight-black')?.availability).toBe('in-stock');
	});
});

describe('purchase', () => {
	const base = { model, quantity: 1, consent: false, adding: false, last: null, inCart: {} };
	it('reasons in order: select-product, stock-loading, stock-error, select-options, out-of-stock, in-cart-limit, consent-required, eligible', () => {
		const s = ready({ 'RH-M-BLK': { inStock: true, availableQuantity: 2 }, 'RH-M-GRN': { inStock: true, availableQuantity: null } });
		const reason = (over: Partial<Parameters<typeof computePurchase>[0]>) => computePurchase({ ...base, stock: s, selected: ['medium', 'midnight-black'], ...over }).purchase.reason;
		expect(reason({ model: null })).toBe('select-product');
		expect(reason({ stock: undefined })).toBe('stock-loading');
		expect(reason({ stock: { status: 'loading', bySku: {} } })).toBe('stock-loading');
		expect(reason({ stock: { status: 'error', bySku: {} } })).toBe('stock-error');
		expect(reason({ selected: ['medium', null] })).toBe('select-options');
		expect(reason({ selected: ['small', 'midnight-black'] })).toBe('out-of-stock');
		expect(reason({ inCart: { 'RH-M-BLK': 2 } })).toBe('in-cart-limit');
		expect(reason({ selected: ['medium', 'forest-green'] })).toBe('consent-required');
		expect(reason({ selected: ['medium', 'forest-green'], consent: true })).toBeNull();
		expect(reason({})).toBeNull();
		expect(reason({ adding: true })).toBe('adding');
	});

	it('the quantity is normalised when the selection or the cap changes (never above maxQuantity)', () => {
		const s = ready({ 'RH-M-BLK': { inStock: true, availableQuantity: 1 }, 'RH-S-BLK': { inStock: true, availableQuantity: null } });
		const big = computePurchase({ ...base, stock: s, selected: ['small', 'midnight-black'], quantity: 10 });
		expect(big.selection.quantity).toBe(10);
		const small = computePurchase({ ...base, stock: s, selected: ['medium', 'midnight-black'], quantity: 10 });
		expect(small.purchase.maxQuantity).toBe(1);
		expect(small.selection.quantity).toBe(1);
		expect(maxQuantityFor({ inStock: true, availableQuantity: 5 }, 3)).toBe(2);
		expect(maxQuantityFor({ inStock: false, availableQuantity: 5 }, 0)).toBe(0);
		expect(maxQuantityFor(undefined, 0)).toBe(0);
	});

	it('a partial selection is kept; a complete one that no longer resolves resets', () => {
		expect(keepSelection(model, ['medium', null])).toEqual(['medium', null]);
		expect(keepSelection(model, ['small', 'forest-green'])).toEqual([null, null]);
		expect(keepSelection(model, ['nope', null])).toEqual([null, null]);
	});
});

describe('add outcome (only the add\'s own response)', () => {
	it('maps every server outcome', () => {
		expect(addResultFrom({ kind: 'applied', line: { quantity: 3, available: true, availableQuantity: 9 } }, 'A', 1)).toEqual({ status: 'added', sku: 'A', quantity: 1, lineQuantity: 3 });
		expect(addResultFrom({ kind: 'applied', line: { quantity: 3, available: true, availableQuantity: null } }, 'A', 1).status).toBe('added');
		expect(addResultFrom({ kind: 'applied', line: { quantity: 3, available: false, availableQuantity: 1 } }, 'A', 2)).toEqual({ status: 'added-unavailable', sku: 'A', quantity: 2, lineQuantity: 3, availableQuantity: 1 });
		expect(addResultFrom({ kind: 'applied', line: { quantity: 3, available: true, availableQuantity: 2 } }, 'A', 2).status).toBe('added-unavailable');
		expect(addResultFrom({ kind: 'applied', line: null }, 'A', 1)).toEqual({ status: 'rejected', reason: 'cart-error', message: null });
		expect(addResultFrom({ kind: 'not-applied' }, 'A', 1)).toMatchObject({ status: 'rejected', reason: 'cart-changed' });
		expect(addResultFrom({ kind: 'error', message: 'Converted' }, 'A', 1)).toEqual({ status: 'rejected', reason: 'cart-error', message: 'Converted' });
	});
});

describe('review round 1', () => {
	it('generated codes never collide with a literal suffixed name, in groups or values', () => {
		const p = buildModelProduct({ slug: 'x', name: 'X', description: null, currency: 'USD', images: [], variants: ['Black', 'black', 'black-2'].map((c, i) => ({
			id: `v${i}`, sku: `S${i}`, name: c, price: 1, salePrice: null, preOrderPrice: null, shipDate: null, isPreOrder: false, assets: [],
			options: [{ id: `o${i}`, code: `o${i}`, name: c, position: i, group: { id: 'g', code: 'g', name: 'Color', position: 0 } }],
		})) } as never, { key: 'x', href: '/x/', rating: null, productId: null });
		const codes = p.groups[0].values.map((v) => v.code);
		expect(new Set(codes).size).toBe(3);
		expect(codes).toEqual(['black', 'black-2', 'black-2-2']);
		expect(p.variants.map((v) => v.options[0].value)).toEqual(codes);
	});

	it('a malformed stock body throws (the reader turns it into that product\'s error, fail closed)', () => {
		expect(() => stockFromResponse({ variants: 'nope' } as never)).toThrow();
		expect(() => stockFromResponse(7 as never)).toThrow();
		expect(stockFromResponse(null)).toEqual({ status: 'ready', bySku: {} });
	});
});
