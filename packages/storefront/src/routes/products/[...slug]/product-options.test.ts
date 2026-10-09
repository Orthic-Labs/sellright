import { describe, expect, it } from 'vitest';
import { availableForGroup, findVariant, getOptionGroups, liveUnitPrice, priceDeltaLabel } from './product-options';
import type { CatalogVariant } from '~/sellright/types/catalog';

// Loose option literals: `position`/`group.position` are required on the wire
// schema, but fixtures intentionally omit them to exercise the pre-migration
// fallback path — the cast preserves `undefined` at runtime.
type LooseOption = {
	id?: string;
	code?: string;
	name: string;
	position?: number;
	group?: { id?: string; code?: string; name: string; position?: number };
};

function variant(over: Partial<Omit<CatalogVariant, 'options'>> & { sku: string; options: LooseOption[] }): CatalogVariant {
	return {
		id: over.sku, name: over.sku, price: 1000, salePrice: null, preOrderPrice: null, shipDate: null,
		compareAtPrice: null, isPreOrder: false, enabled: true, assets: [], fulfillmentType: 'physical',
		appKey: null, inStock: true, availableQuantity: 5,
		...over,
		options: over.options as CatalogVariant['options'],
	};
}

/**
 * Migration 0080 (API): option groups/values carry a merchant-controlled
 * `position`. It is authoritative here too — a merchant ordering values
 * "L, M, S" must see exactly that. The alphabetical/size-word fallbacks run
 * ONLY when position data is absent (an older cached manifest snapshot).
 */
function posVariant(
	options: { group: string; groupPosition?: number; name: string; position?: number }[],
): CatalogVariant {
	return variant({
		sku: 'v',
		options: options.map((o) => ({
			id: `${o.group}:${o.name}`,
			code: `${o.group}:${o.name}`,
			name: o.name,
			position: o.position,
			group: { id: o.group, code: o.group, name: o.group, position: o.groupPosition },
		})),
	});
}

const colorGroup = (name: string) => ({ id: name, code: name, name: 'Color' });

describe('getOptionGroups', () => {
	it('collects unique groups/values across variants, sorted', () => {
		const variants = [
			variant({ sku: 'a', options: [{ id: 'red', code: 'red', name: 'Red', group: colorGroup('color') }] }),
			variant({ sku: 'b', options: [{ id: 'blue', code: 'blue', name: 'Blue', group: colorGroup('color') }] }),
		];
		expect(getOptionGroups(variants)).toEqual([{ groupName: 'Color', values: ['Red', 'Blue'] }]);
	});

	it('orders groups and values by position when every one is set — never alphabetically', () => {
		const variants = [
			posVariant([
				{ group: 'Zebra Color', groupPosition: 0, name: 'Blue', position: 0 },
				{ group: 'Zebra Color', groupPosition: 0, name: 'Red', position: 1 },
				{ group: 'Apple Size', groupPosition: 1, name: 'Large', position: 0 },
				{ group: 'Apple Size', groupPosition: 1, name: 'Small', position: 1 },
			]),
		];
		expect(getOptionGroups(variants)).toEqual([
			{ groupName: 'Zebra Color', values: ['Blue', 'Red'] },
			{ groupName: 'Apple Size', values: ['Large', 'Small'] },
		]);
	});

	it('falls back to alphabetical groups / size-word values when position is entirely absent (pre-migration snapshot)', () => {
		const variants = [
			posVariant([
				{ group: 'Zebra Color', name: 'Red' },
				{ group: 'Zebra Color', name: 'Blue' },
				{ group: 'Size', name: 'L' },
				{ group: 'Size', name: 'S' },
				{ group: 'Size', name: 'M' },
			]),
		];
		const groups = getOptionGroups(variants);
		expect(groups.map((g) => g.groupName)).toEqual(['Size', 'Zebra Color']);
		expect(groups.find((g) => g.groupName === 'Size')!.values).toEqual(['S', 'M', 'L']);
	});

	it('a group missing position falls back for that group only; a fully-positioned group is unaffected', () => {
		const variants = [
			posVariant([
				{ group: 'Positioned', groupPosition: 5, name: 'B', position: 1 },
				{ group: 'Positioned', groupPosition: 5, name: 'A', position: 0 },
				{ group: 'NoPosition', name: 'Z' },
				{ group: 'NoPosition', name: 'A' },
			]),
		];
		const groups = getOptionGroups(variants);
		// Group order falls back to alphabetical (one group lacks a position),
		// but each group's OWN values still honor position where present.
		expect(groups.map((g) => g.groupName)).toEqual(['NoPosition', 'Positioned']);
		expect(groups.find((g) => g.groupName === 'Positioned')!.values).toEqual(['A', 'B']);
	});
});

describe('availableForGroup — LOCKED stock rule', () => {
	const groups = [{ groupName: 'Color', values: ['Red', 'Blue'] }];

	it('excludes an out-of-stock, non-pre-order variant', () => {
		const variants = [
			variant({ sku: 'red', inStock: false, isPreOrder: false, options: [{ id: 'red', code: 'red', name: 'Red', group: colorGroup('color') }] }),
			variant({ sku: 'blue', inStock: true, options: [{ id: 'blue', code: 'blue', name: 'Blue', group: colorGroup('color') }] }),
		];
		expect(availableForGroup(variants, groups, 0, [])).toEqual(new Set(['Blue']));
	});

	it('includes an out-of-stock pre-order variant (pre-order is always selectable)', () => {
		const variants = [
			variant({ sku: 'red', inStock: false, isPreOrder: true, options: [{ id: 'red', code: 'red', name: 'Red', group: colorGroup('color') }] }),
		];
		expect(availableForGroup(variants, groups, 0, [])).toEqual(new Set(['Red']));
	});
});

describe('findVariant', () => {
	it('returns the single variant when there are no option groups', () => {
		const v = variant({ sku: 'only', options: [] });
		expect(findVariant([v], [], [])).toBe(v);
	});

	it('resolves the exact variant matching all selected values', () => {
		const groups = [{ groupName: 'Color', values: ['Red', 'Blue'] }];
		const red = variant({ sku: 'red', options: [{ id: 'red', code: 'red', name: 'Red', group: colorGroup('color') }] });
		const blue = variant({ sku: 'blue', options: [{ id: 'blue', code: 'blue', name: 'Blue', group: colorGroup('color') }] });
		expect(findVariant([red, blue], groups, ['Blue'])).toBe(blue);
	});

	it('returns undefined for an incomplete selection', () => {
		const groups = [{ groupName: 'Color', values: ['Red'] }];
		const red = variant({ sku: 'red', options: [{ id: 'red', code: 'red', name: 'Red', group: colorGroup('color') }] });
		expect(findVariant([red], groups, [null])).toBeUndefined();
	});
});

describe('priceDeltaLabel — effective price, not raw price', () => {
	it('uses the sale price (not the regular price) when computing the delta', () => {
		const groups = [
			{ groupName: 'Size', values: ['S', 'L'] },
			{ groupName: 'Color', values: ['Red'] },
		];
		// Without a sale, S (1000) would be the overall cheapest, giving it a $0
		// delta — the sale price (500) is what should actually drive the math.
		const s = variant({ sku: 's', price: 1000, salePrice: 500, options: [{ id: 's', code: 's', name: 'S', group: { id: 'size', code: 'size', name: 'Size' } }] });
		const l = variant({ sku: 'l', price: 1000, options: [{ id: 'l', code: 'l', name: 'L', group: { id: 'size', code: 'size', name: 'Size' } }] });
		// S IS the overall-cheapest variant once its sale price is used — $0 delta.
		expect(priceDeltaLabel([s, l], groups, 'S')).toBeNull();
		// L (1000) vs the overall min (S's effective 500) — delta should reflect
		// the sale price, not S's raw $1000 price (which would give +$0).
		expect(priceDeltaLabel([s, l], groups, 'L')).toBe('+$5');
	});
});

describe('liveUnitPrice', () => {
	it('quotes the pre-order price on a pre-order, the sale price on a sale, else the regular price', () => {
		expect(liveUnitPrice({ salePrice: 800, preOrderPrice: null }, false, 1000)).toBe(800);
		expect(liveUnitPrice({ salePrice: null, preOrderPrice: 700 }, true, 1000)).toBe(700);
		expect(liveUnitPrice({ salePrice: 800, preOrderPrice: 700 }, true, 1000)).toBe(700);
		expect(liveUnitPrice({ salePrice: 800, preOrderPrice: 700 }, false, 1000)).toBe(800);
		expect(liveUnitPrice({ salePrice: null, preOrderPrice: null }, false, 1000)).toBe(1000);
		expect(liveUnitPrice({ salePrice: 0, preOrderPrice: 0 }, true, 1000)).toBe(1000);
		expect(liveUnitPrice(undefined, false, 1000)).toBe(1000);
	});
});
