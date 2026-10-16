// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRODUCT_PATH_SETTING, productPath, productPathFor } from './product-path';
import { detailSet, productSlugOf, withCanonicalUrls } from './product-detail-model';

describe('product path (brand views PR2 §9)', () => {
	it('both settings, slug encoded, trailing slash; the base default is /products/', () => {
		expect(productPathFor('/products/:slug/', 'tee')).toBe('/products/tee/');
		expect(productPathFor('/shop/:slug/', 'a b')).toBe('/shop/a%20b/');
		expect(PRODUCT_PATH_SETTING).toBe('/products/:slug/');
		expect(productPath('x')).toBe('/products/x/');
	});

	it('a product route serves only on the configured prefix', () => {
		expect(productSlugOf('/products/tee/', { slug: 'tee/' })).toBe('tee');
		expect(productSlugOf('/shop/tee/', { slug: 'tee' })).toBeNull();
	});

	it('the product set: a configurator member brings its siblings; any other slug reads alone', () => {
		const members = [{ key: 'short', slug: 's' }, { key: 'long', slug: 'l' }];
		expect(detailSet('l', members)).toEqual([{ key: 'long', slug: 'l' }, { key: 'short', slug: 's' }]);
		expect(detailSet('x', members)).toEqual([{ key: 'x', slug: 'x' }]);
	});

	it('the API JSON-LD keeps price and availability; only its own URLs follow the storefront canonical', () => {
		const out = withCanonicalUrls({ '@type': 'Product', url: 'https://s/products/a/', offers: { url: 'https://s/products/a/', price: '75.00', availability: 'https://schema.org/InStock' } } as never, 'https://s/shop/a/') as Record<string, any>;
		expect(out.url).toBe('https://s/shop/a/');
		expect(out.offers).toEqual({ url: 'https://s/shop/a/', price: '75.00', availability: 'https://schema.org/InStock' });
	});

	it('no product URL is built outside product-path.ts (the L2 cards keep only their documented default)', () => {
		const SRC = fileURLToPath(new URL('..', import.meta.url));
		const ALLOWED = new Set(['platform/product-path.ts', 'components/products/ProductCard.tsx', 'components/home/HomeTeeSection.tsx']);
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) { if (e.name !== '__fixtures__' && e.name !== '__stubs__') walk(p); continue; }
				if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
				const rel = path.relative(SRC, p).split(path.sep).join('/');
				if (!ALLOWED.has(rel) && /(`|\})\/products\/\$\{/.test(fs.readFileSync(p, "utf8"))) offenders.push(rel);
			}
		};
		walk(SRC);
		expect(offenders).toEqual([]);
	});
});
