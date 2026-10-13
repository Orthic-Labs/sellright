// @vitest-environment node
// Brand views PR2 §3: forged and out-of-range calls are `invalid` with no state change and no request.
import { describe, expect, it } from 'vitest';
import type { CatalogProduct } from '~/sellright/types/catalog';
import { buildModelProduct } from './product-model';
import { changeConsent, changeQuantity, productKeyFromQuery, projectConfigurator, selectOption, selectProduct, type ConfiguratorCtl, type ConfiguratorSource } from './configurator-model';
import { initialStockCtl } from './stock-read';

const product = (slug: string, preOrder = false) =>
	buildModelProduct(
		{
			slug, name: slug, description: '', tags: [], status: 'active', seoTitle: null, seoDescription: null, currency: 'USD', images: [],
			variants: ['Small', 'Medium'].map((size, i) => ({
				id: `${slug}-${i}`, sku: `${slug}-${i}`, name: size, price: 100, salePrice: null, preOrderPrice: null, shipDate: null, compareAtPrice: null,
				isPreOrder: preOrder, enabled: true, fulfillmentType: 'physical', appKey: null, inStock: false, availableQuantity: 0, assets: [],
				options: [{ id: `id-${i}`, code: `id-${i}`, name: size, position: i, group: { id: 'g9', code: 'g9', name: 'Size', position: 0 } }],
			})),
		} as unknown as CatalogProduct,
		{ key: slug === 'shortsleeveshirt' ? 'short' : 'long', href: `/shop/${slug}/`, rating: null, productId: null },
	);
const SHORT = product('shortsleeveshirt');
const LONG = product('longsleeveshirt', true);
const source: ConfiguratorSource = { products: [SHORT, LONG], siblings: [], selectable: true };
const ctlOf = (over: Partial<ConfiguratorCtl> = {}): ConfiguratorCtl => ({ disposed: false, admitted: [], ...initialStockCtl(), productKey: null, selected: [], quantity: 1, consent: false, adding: false, last: null, ...over });

describe('configurator methods', () => {
	it('forged product, group, value and argument types are invalid and change nothing', () => {
		const ctl = ctlOf();
		const before = JSON.stringify(ctl);
		expect(selectProduct(ctl, source, 'nope')).toEqual({ ok: false, reason: 'invalid' });
		expect(selectProduct(ctl, source, 7)).toEqual({ ok: false, reason: 'invalid' });
		expect(selectProduct(ctl, { ...source, selectable: false }, 'short')).toEqual({ ok: false, reason: 'invalid' });
		expect(selectOption(ctl, source, 'size', 'small')).toEqual({ ok: false, reason: 'invalid' }); // no product focused
		expect(JSON.stringify(ctl)).toBe(before);
		expect(selectProduct(ctl, source, 'short')).toEqual({ ok: true });
		const focused = JSON.stringify(ctl);
		for (const [g, v] of [['colour', 'small'], ['size', 'xl'], ['size', 'id-0'], ['g9', 'small']] as const) expect(selectOption(ctl, source, g, v)).toEqual({ ok: false, reason: 'invalid' });
		expect(selectOption(ctl, source, 'size', 1 as never)).toEqual({ ok: false, reason: 'invalid' });
		expect(JSON.stringify(ctl)).toBe(focused);
		expect(selectOption(ctl, source, 'size', 'small')).toEqual({ ok: true });
		expect(ctl.selected).toEqual(['small']);
		expect(selectOption(ctl, source, 'size', null)).toEqual({ ok: true });
		expect(ctl.selected).toEqual([null]);
	});

	it('quantity: 0, 11, 1.5, NaN, a string and anything above maxQuantity are invalid', () => {
		const ctl = ctlOf({ productKey: 'short', selected: ['small'], stock: { shortsleeveshirt: { status: 'ready', bySku: { 'shortsleeveshirt-0': { inStock: true, availableQuantity: 3 } } } } });
		for (const q of [0, 11, 1.5, Number.NaN, '2', 4]) expect(changeQuantity(ctl, source, [], q)).toEqual({ ok: false, reason: 'invalid' });
		expect(changeQuantity(ctl, source, [{ sku: 'shortsleeveshirt-0', quantity: 1 }], 3)).toEqual({ ok: false, reason: 'invalid' });
		expect(ctl.quantity).toBe(1);
		expect(changeQuantity(ctl, source, [], 3)).toEqual({ ok: true });
		expect(projectConfigurator(ctl, source, []).selection.quantity).toBe(3);
	});

	it('consent: true only for a resolved pre-order whose live read is in stock', () => {
		const plain = ctlOf({ productKey: 'short', selected: ['small'], stock: { shortsleeveshirt: { status: 'ready', bySku: { 'shortsleeveshirt-0': { inStock: true, availableQuantity: 3 } } } } });
		expect(changeConsent(plain, source, [], true)).toEqual({ ok: false, reason: 'invalid' });
		const oos = ctlOf({ productKey: 'long', selected: ['small'], stock: { longsleeveshirt: { status: 'ready', bySku: { 'longsleeveshirt-0': { inStock: false, availableQuantity: 0 } } } } });
		expect(changeConsent(oos, source, [], true)).toEqual({ ok: false, reason: 'invalid' });
		const pre = ctlOf({ productKey: 'long', selected: ['small'], stock: { longsleeveshirt: { status: 'ready', bySku: { 'longsleeveshirt-0': { inStock: true, availableQuantity: null } } } } });
		expect(projectConfigurator(pre, source, []).purchase.reason).toBe('consent-required');
		expect(changeConsent(pre, source, [], true)).toEqual({ ok: true });
		expect(projectConfigurator(pre, source, []).purchase.eligible).toBe(true);
		expect(changeConsent(pre, source, [], 'yes')).toEqual({ ok: false, reason: 'invalid' });
	});

	it('?style= / ?sleeve= pick the initial product; the first listed param present wins; unknown values pick nothing', () => {
		const pq = { params: ['style', 'sleeve'], values: { short: 'short', long: 'long' } };
		expect(productKeyFromQuery(new URLSearchParams('sleeve=long'), source.products, pq)).toBe('long');
		expect(productKeyFromQuery(new URLSearchParams('style=short&sleeve=long'), source.products, pq)).toBe('short');
		expect(productKeyFromQuery(new URLSearchParams('style=tank'), source.products, pq)).toBeNull();
		expect(productKeyFromQuery(new URLSearchParams(''), source.products, pq)).toBeNull();
	});

	it('every product is projected with its own live stock; a product never read is unchecked', () => {
		const ctl = ctlOf({ productKey: 'short', selected: [null], stock: { shortsleeveshirt: { status: 'ready', bySku: {} } } });
		const view = projectConfigurator(ctl, source, []);
		expect(view.products.map((p) => p.availability)).toEqual(['out-of-stock', 'unchecked']);
		expect(view.purchase.reason).toBe('select-options');
	});
});
