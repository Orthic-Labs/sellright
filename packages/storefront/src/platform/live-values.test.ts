// ADR-0001 lane S2: the pure half of the live-values read (redaction, fail-closed merge, generation check) and the server switch.
import { afterEach, describe, expect, it } from 'vitest';
import { FAIL_CLOSED_VALUES, applyVariantPrices, cardState, cardValuesOf, redactListItem, settleLiveRead, valuesBySlug, withCardValues, type LiveReadState, type ValuedItem } from './live-values';
import { shellRender } from './shell-render';

const item = (slug: string, price: number, inStock: boolean): ValuedItem & { name: string } => ({
	slug,
	name: slug,
	inStock,
	minPrice: price,
	maxPrice: price + 1000,
	pricingVariant: { sku: `${slug}-1`, price, salePrice: price - 100, preOrderPrice: null, isPreOrder: false, shipDate: null, shipDateLabel: null },
});

describe('shell redaction of a listing item', () => {
	it('keeps metadata, removes every price and the stock flag (fail-closed constant)', () => {
		const r = redactListItem(item('tee', 4567, true));
		expect(r.name).toBe('tee');
		expect(r).toMatchObject({ inStock: false, minPrice: null, maxPrice: null, pricingVariant: null });
		expect(JSON.stringify(r)).not.toMatch(/4567|4467|5567/);
	});
});

describe('values after the client read', () => {
	it('applies the read per slug; a slug the read omitted is fail closed', () => {
		const shell = [redactListItem(item('a', 4567, false)), redactListItem(item('b', 1200, false))];
		const live = valuesBySlug([item('a', 4567, true)]);
		const [a, b] = shell.map((p) => withCardValues(p, live));
		expect(a).toMatchObject({ inStock: true, minPrice: 4567, maxPrice: 5567, pricingVariant: { price: 4567, salePrice: 4467 } });
		expect(b).toMatchObject({ inStock: false, minPrice: null, pricingVariant: null });
		expect(cardValuesOf(b)).toEqual(FAIL_CLOSED_VALUES);
	});

	it('card state: pending until settled, price placeholder until ready; not deferred = no placeholders', () => {
		expect(cardState('idle', true)).toEqual({ pending: true, pricePending: true });
		expect(cardState('loading', true)).toEqual({ pending: true, pricePending: true });
		expect(cardState('ready', true)).toEqual({ pending: false, pricePending: false });
		expect(cardState('error', true)).toEqual({ pending: false, pricePending: true });
		expect(cardState('idle', false)).toEqual({ pending: false, pricePending: false });
	});

	it('PDP: live prices by SKU over the shell variants; stock fields untouched', () => {
		const shell = [{ sku: 'A', price: 0, salePrice: null, preOrderPrice: null, stockLevel: '0' }, { sku: 'B', price: 0, salePrice: null, preOrderPrice: null, stockLevel: '0' }];
		const out = applyVariantPrices(shell, [{ sku: 'A', price: 4567, salePrice: 3999, preOrderPrice: null }]);
		expect(out[0]).toEqual({ sku: 'A', price: 4567, salePrice: 3999, preOrderPrice: null, stockLevel: '0' });
		expect(out[1]).toBe(shell[1]);
	});
});

describe('settleLiveRead: only the latest read of the current view applies', () => {
	const state = (): LiveReadState<number> => ({ status: 'loading', value: null, key: 'v2', gen: 3 });
	it('applies the current generation', () => {
		const s = state();
		expect(settleLiveRead(s, 3, 'v2', { ok: true, value: 7 })).toBe(true);
		expect(s).toMatchObject({ status: 'ready', value: 7 });
	});
	it('drops an older generation or another view', () => {
		const s = state();
		expect(settleLiveRead(s, 2, 'v2', { ok: true, value: 7 })).toBe(false);
		expect(settleLiveRead(s, 3, 'v1', { ok: true, value: 7 })).toBe(false);
		expect(s).toMatchObject({ status: 'loading', value: null });
	});
	it('a failed read is error with no value (callers fail closed)', () => {
		const s = state();
		settleLiveRead(s, 3, 'v2', { ok: false });
		expect(s).toMatchObject({ status: 'error', value: null });
	});
});

describe('shellRender follows SHELL_CACHE (lane S3 shellCacheEnabled)', () => {
	const before = process.env.SHELL_CACHE;
	afterEach(() => {
		if (before === undefined) delete process.env.SHELL_CACHE;
		else process.env.SHELL_CACHE = before;
	});
	it('off unless SHELL_CACHE=1', () => {
		delete process.env.SHELL_CACHE;
		expect(shellRender()).toBe(false);
		process.env.SHELL_CACHE = 'true';
		expect(shellRender()).toBe(false);
		process.env.SHELL_CACHE = '1';
		expect(shellRender()).toBe(true);
	});
});
