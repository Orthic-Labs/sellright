// #382 follow-up: every PDP manifest path gets the catalog in-stock hint, including generations whose v1 products/<slug>.json has
// no `inStock` (live DD before 9eba89c2's publisher), where only products-v2/<slug>.json carries it.
import { describe, expect, it } from 'vitest';
import { catalogInStockOf, v1DetailFile, v2DetailFile } from './catalog-stock-hint';
import { productFromManifest } from './product';
import { modelsFromManifest } from './product-detail';

const v1 = (extra: Record<string, unknown> = {}) => ({
	slug: 'monsuta-bead', name: 'Monsuta Bead', description: null, assets: [],
	variants: [{ id: 'MB-1', sku: 'MB-1', name: 'Copper', price: 3500, options: [], assets: [] }],
	...extra,
});
/** A fake one-generation read: only the files given exist. */
const generation = (files: Record<string, unknown>) => (async <T,>(names: readonly string[]) =>
	({ generation: 'g', files: Object.fromEntries(names.map((n) => [n, (files[n] ?? null) as T | null])) })) as never;

describe('catalogInStockOf', () => {
	it('takes v1, else v2, else unknown', () => {
		expect(catalogInStockOf({ inStock: false }, { inStock: true })).toBe(false);
		expect(catalogInStockOf({}, { inStock: true })).toBe(true);
		expect(catalogInStockOf({}, null)).toBeNull();
		expect(catalogInStockOf({ inStock: 'yes' }, { inStock: 1 })).toBeNull();
	});
});

describe('base PDP loader (platform/product.ts)', () => {
	it('an older generation (v1 without inStock) still gets the hint from products-v2', async () => {
		const out = await productFromManifest('monsuta-bead', generation({
			[v1DetailFile('monsuta-bead')]: v1(), [v2DetailFile('monsuta-bead')]: { inStock: true },
		}));
		expect(out?.source).toBe('manifest');
		expect(out?.catalogInStock).toBe(true);
	});
	it('a current generation uses the v1 flag', async () => {
		const out = await productFromManifest('monsuta-bead', generation({ [v1DetailFile('monsuta-bead')]: v1({ inStock: false }) }));
		expect(out?.catalogInStock).toBe(false);
	});
	it('no v1 file, or an unusable generation: null, so the loader serves the live API', async () => {
		expect(await productFromManifest('monsuta-bead', generation({ [v2DetailFile('monsuta-bead')]: { inStock: true } }))).toBeNull();
		expect(await productFromManifest('monsuta-bead', (async () => { throw new Error('stale'); }) as never)).toBeNull();
	});
});

describe('brand PDP loader (platform/product-detail.ts)', () => {
	it('carries the hint onto the model from v1 or v2, and a missing v2 file is not an error', async () => {
		const models = await modelsFromManifest([{ key: 'a', slug: 'monsuta-bead' }, { key: 'b', slug: 'other' }], generation({
			[v1DetailFile('monsuta-bead')]: v1(), [v2DetailFile('monsuta-bead')]: { inStock: true },
			[v1DetailFile('other')]: v1({ slug: 'other', inStock: false }),
		}));
		expect(models?.map((m) => m.catalogInStock)).toEqual([true, false]);
	});
});
