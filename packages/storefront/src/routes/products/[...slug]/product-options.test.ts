import { describe, expect, it } from 'vitest';
import {
	areAllVariantsSoldOut,
	availableForGroup,
	selectOptionValue,
	findVariant,
	getOptionGroups,
	isActivePreOrder,
	isPaintedSoldOut,
	paintStockHint,
	isPreOrderPresented,
	isSelectionOutOfStock,
	isStockHintPending,
	isVariantPurchasable,
	liveUnitPrice,
	optionPriceFor,
	priceDeltaLabel,
} from './product-options';
import type { CatalogVariant } from '~/sellright/types/catalog';
import { toCartEnrichment } from '~/platform/controllers/product-model';
import { formatPrice } from '~/utils/price-format';

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

	it('excludes an out-of-stock pre-order variant (live stock wins over the pre-order flag)', () => {
		const variants = [
			variant({ sku: 'red', inStock: false, isPreOrder: true, options: [{ id: 'red', code: 'red', name: 'Red', group: colorGroup('color') }] }),
		];
		expect(availableForGroup(variants, groups, 0, [])).toEqual(new Set());
	});

	it('includes an in-stock pre-order variant', () => {
		const variants = [
			variant({ sku: 'red', inStock: true, isPreOrder: true, options: [{ id: 'red', code: 'red', name: 'Red', group: colorGroup('color') }] }),
		];
		expect(availableForGroup(variants, groups, 0, [])).toEqual(new Set(['Red']));
	});
});

describe('PDP stock state — live stock is authoritative over the pre-order flag', () => {
	const preOOS = variant({ sku: 'pre-oos', inStock: false, isPreOrder: true, options: [] });
	const preLive = variant({ sku: 'pre-live', inStock: true, isPreOrder: true, options: [] });
	const plainOOS = variant({ sku: 'plain-oos', inStock: false, isPreOrder: false, options: [] });
	const plainLive = variant({ sku: 'plain-live', inStock: true, isPreOrder: false, options: [] });

	it('pre-order + inStock=false -> out of stock, not purchasable, no pre-order presentation', () => {
		expect(isSelectionOutOfStock(true, preOOS)).toBe(true);
		expect(isVariantPurchasable(preOOS)).toBe(false);
		expect(isActivePreOrder(preOOS)).toBe(false);
		expect(isPreOrderPresented(preOOS, [preOOS])).toBe(false);
	});

	it('pre-order + inStock=true -> purchasable with pre-order presentation', () => {
		expect(isSelectionOutOfStock(true, preLive)).toBe(false);
		expect(isVariantPurchasable(preLive)).toBe(true);
		expect(isActivePreOrder(preLive)).toBe(true);
		expect(isPreOrderPresented(preLive, [preLive])).toBe(true);
	});

	it('non-pre-order + inStock=false -> out of stock', () => {
		expect(isSelectionOutOfStock(true, plainOOS)).toBe(true);
		expect(isVariantPurchasable(plainOOS)).toBe(false);
		expect(isActivePreOrder(plainOOS)).toBe(false);
	});

	it('non-pre-order + inStock=true -> purchasable, not a pre-order', () => {
		expect(isSelectionOutOfStock(true, plainLive)).toBe(false);
		expect(isVariantPurchasable(plainLive)).toBe(true);
		expect(isPreOrderPresented(plainLive, [plainLive])).toBe(false);
	});

	it('disabled variants remain unavailable even when stock & pre-order flags are true', () => {
		const disabled = variant({ sku: 'disabled', enabled: false, inStock: true, isPreOrder: true, options: [] });
		expect(isVariantPurchasable(disabled)).toBe(false);
		expect(isActivePreOrder(disabled)).toBe(false);
		expect(areAllVariantsSoldOut([disabled])).toBe(true);
	});

	it('missing stock fails closed (never purchasable)', () => {
		const missing = { isPreOrder: true } as unknown as CatalogVariant;
		expect(isVariantPurchasable(missing)).toBe(false);
		expect(isSelectionOutOfStock(true, missing)).toBe(true);
		expect(isActivePreOrder(missing)).toBe(false);
		expect(isVariantPurchasable(undefined)).toBe(false);
	});

	it('incomplete or unresolved selection is never reported out of stock', () => {
		expect(isSelectionOutOfStock(false, preOOS)).toBe(false);
		expect(isSelectionOutOfStock(true, undefined)).toBe(false);
	});

	it('allVariantsSoldOut ignores the pre-order flag', () => {
		expect(areAllVariantsSoldOut([preOOS, plainOOS])).toBe(true);
		expect(areAllVariantsSoldOut([preOOS])).toBe(true);
		expect(areAllVariantsSoldOut([preOOS, preLive])).toBe(false);
		expect(areAllVariantsSoldOut([plainOOS, plainLive])).toBe(false);
	});

	it('with no variant selected, pre-order presents only if some pre-order variant is live in stock', () => {
		expect(isPreOrderPresented(undefined, [preOOS, plainLive])).toBe(false);
		expect(isPreOrderPresented(undefined, [preOOS, preLive])).toBe(true);
	});
});

describe('findVariant', () => {
	it('returns the single variant when there are no option groups', () => {
		const v = variant({ sku: 'only', options: [] });
		expect(findVariant([v], [], [])).toBe(v);
	});

	it('requires an explicit SKU for multiple named variants without options', () => {
		const white = variant({ sku: 'white-sku', name: 'White', inStock: false, options: [] });
		const black = variant({ sku: 'black-sku', name: 'Black', options: [] });
		for (const selection of [[], [null], ['missing'], ['Black'], ['white-sku', 'black-sku']]) {
			expect(findVariant([white, black], [], selection)).toBeUndefined();
		}
		expect(getOptionGroups([white, black])).toEqual([]);
	});

	it('carries the chosen second SKU, price & name into cart enrichment without fabricated options', () => {
		const white = variant({ sku: 'white-sku', name: 'White', price: 1200, inStock: false, availableQuantity: 0, options: [] });
		const black = variant({ id: 'catalog-id', sku: 'black-sku', name: 'Black', price: 1575, salePrice: 1495, options: [] });
		const chosen = findVariant([white, black], [], ['black-sku']);
		expect(chosen).toBe(black);
		expect(chosen?.sku).toBe('black-sku');
		expect(isVariantPurchasable(chosen)).toBe(true);
		expect(liveUnitPrice(chosen, false, chosen!.price)).toBe(1495);
		expect(formatPrice(liveUnitPrice(chosen, false, chosen!.price), 'USD')).toBe('$14.95');
		expect(toCartEnrichment({ slug: 'bead' }, chosen!, undefined)).toMatchObject({ slug: 'bead', name: 'Black', options: '' });
		expect(findVariant([white, black], [], ['catalog-id'])).toBeUndefined();
	});

	it('retains exact named selection when stock changes, while blocking unavailable or disabled adds', () => {
		const white = variant({ sku: 'white-sku', name: 'White', inStock: false, options: [] });
		const black = variant({ sku: 'black-sku', name: 'Black', options: [] });
		for (const unavailable of [
			{ ...black, inStock: false, availableQuantity: 0 },
			{ ...black, enabled: false },
		]) {
			const chosen = findVariant([white, unavailable], [], ['black-sku']);
			expect(chosen?.sku).toBe('black-sku');
			expect(isVariantPurchasable(chosen)).toBe(false);
			expect(isSelectionOutOfStock(true, chosen)).toBe(true);
		}
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

describe('optionPriceFor — #398 an option quotes the variant it would select', () => {
	const opt = (group: string, name: string) => ({ id: name, code: name, name, group: { id: group, code: group, name: group } });
	const groups = [
		{ groupName: 'Material', values: ['Stonewash Titanium', 'Ultem'] },
		{ groupName: 'Plates', values: ['Normal', 'Trick'] },
	];
	// Ronin V2 as published on Damned (2026-10-27): the material sets the price.
	const ronin = [
		variant({ sku: 'ronv2swtinor', price: 11500, options: [opt('Material', 'Stonewash Titanium'), opt('Plates', 'Normal')] }),
		variant({ sku: 'ronv2swtitr', price: 11500, options: [opt('Material', 'Stonewash Titanium'), opt('Plates', 'Trick')] }),
		variant({ sku: 'ronv2ulnor', price: 10000, options: [opt('Material', 'Ultem'), opt('Plates', 'Normal')] }),
		variant({ sku: 'ronv2ultri', price: 10000, options: [opt('Material', 'Ultem'), opt('Plates', 'Trick')] }),
	];
	it('Ultem selected: Normal and Trick quote the Ultem price ($100), not the first Titanium variant ($115)', () => {
		expect(optionPriceFor(ronin, groups, 1, 'Normal', ['Ultem', null])).toBe(10000);
		expect(optionPriceFor(ronin, groups, 1, 'Trick', ['Ultem', null])).toBe(10000);
		expect(optionPriceFor(ronin, groups, 1, 'Trick', ['Stonewash Titanium', 'Normal'])).toBe(11500);
	});
	it('prices that differ per combination: each option quotes its own combination; open groups take the cheapest', () => {
		const grid = [
			variant({ sku: 'a1', price: 10000, options: [opt('Material', 'Ultem'), opt('Plates', 'Normal')] }),
			variant({ sku: 'a2', price: 11500, options: [opt('Material', 'Ultem'), opt('Plates', 'Trick')] }),
			variant({ sku: 'b1', price: 12000, options: [opt('Material', 'Stonewash Titanium'), opt('Plates', 'Normal')] }),
			variant({ sku: 'b2', price: 13500, options: [opt('Material', 'Stonewash Titanium'), opt('Plates', 'Trick')], salePrice: 12500 }),
		];
		expect(optionPriceFor(grid, groups, 1, 'Trick', ['Ultem', null])).toBe(11500);
		expect(optionPriceFor(grid, groups, 1, 'Trick', ['Stonewash Titanium', null])).toBe(12500); // effective (sale) price
		expect(optionPriceFor(grid, groups, 0, 'Stonewash Titanium', [null, 'Normal'])).toBe(12000);
		expect(optionPriceFor(grid, groups, 1, 'Normal', [null, null])).toBe(10000);
	});
	it('no variant for the combination falls back to the cheapest with the value; unknown value is null', () => {
		const sparse = [ronin[0], ronin[3]];
		expect(optionPriceFor(sparse, groups, 1, 'Normal', ['Ultem', null])).toBe(11500);
		expect(optionPriceFor(ronin, groups, 1, 'Sideways', ['Ultem', null])).toBeNull();
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

describe('manifest in-stock hint (first paint before the live read)', () => {
	const unchecked = [variant({ sku: 'A', options: [], inStock: false, availableQuantity: 0 })];
	it('does not paint an in-stock product sold out until a live read lands', () => {
		expect(isPaintedSoldOut(unchecked, true, false)).toBe(false);
		expect(isStockHintPending(true, false)).toBe(true);
		expect(isSelectionOutOfStock(true, unchecked[0], isStockHintPending(true, false))).toBe(false);
	});
	it('keeps the live read authoritative once loaded', () => {
		expect(isPaintedSoldOut(unchecked, true, true)).toBe(true);
		expect(isSelectionOutOfStock(true, unchecked[0], isStockHintPending(true, true))).toBe(true);
	});
	it('an unknown or sold-out hint never suppresses sold out', () => {
		expect(isPaintedSoldOut(unchecked, null, false)).toBe(true);
		expect(isPaintedSoldOut(unchecked, false, false)).toBe(true);
		expect(isStockHintPending(undefined, false)).toBe(false);
	});
	it('the hint never makes a variant purchasable', () => {
		expect(isVariantPurchasable(unchecked[0])).toBe(false);
	});
});

describe('#408 options in any order', () => {
	const group = (name: string) => ({ id: name, code: name, name });
	const blade = (code: string) => ({ id: code, code, name: code, group: group('blade') });
	const handle = (code: string) => ({ id: code, code, name: code, group: group('handle') });
	const groups = [{ groupName: 'blade', values: ['Stonewash', 'Black'] }, { groupName: 'handle', values: ['Red', 'Blue'] }];
	// Stonewash comes in Red and Blue; Black only in Red; Black/Blue is sold out.
	const variants = [
		variant({ sku: 'sw-red', inStock: true, options: [blade('Stonewash'), handle('Red')] }),
		variant({ sku: 'sw-blue', inStock: true, options: [blade('Stonewash'), handle('Blue')] }),
		variant({ sku: 'bk-red', inStock: true, options: [blade('Black'), handle('Red')] }),
		variant({ sku: 'bk-blue', inStock: false, options: [blade('Black'), handle('Blue')] }),
	];

	it('a later group is open before the first is chosen', () => {
		expect(availableForGroup(variants, groups, 1, [null, null])).toEqual(new Set(['Red', 'Blue']));
	});

	it('choosing the handle first narrows the blades, not the other way only', () => {
		expect(availableForGroup(variants, groups, 0, [null, 'Blue'])).toEqual(new Set(['Stonewash']));
		expect(availableForGroup(variants, groups, 1, ['Black', null])).toEqual(new Set(['Red']));
	});

	it('keeps a compatible choice and clears an impossible one', () => {
		expect(selectOptionValue(variants, groups, [null, 'Red'], 0, 'Black')).toEqual(['Black', 'Red']);
		expect(selectOptionValue(variants, groups, [null, 'Blue'], 0, 'Black')).toEqual(['Black', null]);
		expect(selectOptionValue(variants, groups, ['Black', null], 1, 'Blue')).toEqual([null, 'Blue']);
	});
});

describe('ADR-0001 shell (valuesPending): availability not known yet', () => {
	const unchecked = [variant({ sku: 'A', options: [], inStock: false, availableQuantity: 0 })];
	it('the redacted shell (catalogInStock null) paints no Sold Out before the live read', () => {
		const hint = paintStockHint(true, null);
		expect(isPaintedSoldOut(unchecked, hint, false)).toBe(false);
		expect(isSelectionOutOfStock(true, unchecked[0], isStockHintPending(hint, false))).toBe(false);
	});
	it('the live read stays authoritative (a real sold-out paints once loaded) and nothing becomes purchasable', () => {
		expect(isPaintedSoldOut(unchecked, paintStockHint(true, null), true)).toBe(true);
		expect(isVariantPurchasable(unchecked[0]!)).toBe(false);
	});
	it('switch off: the manifest hint is used unchanged', () => {
		expect(paintStockHint(false, null)).toBeNull();
		expect(paintStockHint(false, false)).toBe(false);
		expect(paintStockHint(false, true)).toBe(true);
		expect(isPaintedSoldOut(unchecked, paintStockHint(false, null), false)).toBe(true);
	});
});
