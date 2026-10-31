// ADR-0001 #412: the /shop/ shell (SHELL_CACHE=1) paints its grid in SSR from the cached structure (names, images, links): no price,
// no availability and no stock filtering until the browser's manifest read lands. With the switch off the listing renders as before.
import { QwikRouterMockProvider } from '@qwik.dev/router';
import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogListItem } from '~/sellright/types/catalog';

const g = globalThis as unknown as { __shopCatalog: unknown };
vi.mock('~/platform/shop', async (importOriginal) => ({
	...(await importOriginal<typeof import('~/platform/shop')>()),
	useCatalogLoader: () => ({ value: g.__shopCatalog }),
}));

const { default: ShopPage } = await import('./index');
const { shellShopItem } = await import('~/platform/shop');

const PRICE = 4567;
const PRICE_STRINGS = ['4567', '45.67', '$46', '$45', '4467', '44.67'];
const STOCK_STRINGS = ['"inStock":true', 'schema.org/InStock', '"InStock"', 'In stock', 'in-stock', 'Sold Out', 'OutOfStock', 'IN_STOCK', 'OUT_OF_STOCK'];
const priceFree = (text: string) => PRICE_STRINGS.filter((s) => text.includes(s));
const stockFree = (text: string) => STOCK_STRINGS.filter((s) => text.includes(s));
const listItem = (slug: string, inStock = true): CatalogListItem => ({
	slug, name: `Name ${slug}`, status: 'active', inStock, tags: ['tee'], minPrice: PRICE, maxPrice: PRICE + 1000, image: `/img/${slug}.jpg`,
	pricingVariant: { sku: slug, price: PRICE, salePrice: PRICE - 100, preOrderPrice: null, isPreOrder: false, shipDate: null, shipDateLabel: null },
});
const full = [listItem('tee'), listItem('cap', false)];

const render = async (catalog: { totalItems: number; products: CatalogListItem[]; fallback: boolean; deferred: boolean }) => {
	g.__shopCatalog = catalog;
	return (await ssrRenderToDom(<QwikRouterMockProvider url="http://localhost/shop/"><ShopPage /></QwikRouterMockProvider>, {})).document;
};

describe('/shop/ shell grid (#412)', () => {
	it('SSR paints every product of the structure (names, links, images), unfiltered by stock; no price or stock text', async () => {
		const document = await render({ totalItems: 2, products: full.map(shellShopItem), fallback: false, deferred: true });
		const grid = document.querySelector('[data-listing-pending]')!.innerHTML;
		expect(grid).toContain('Name tee');
		expect(grid).toContain('Name cap'); // the in-stock filter never applies to the redacted constant
		expect(grid).toContain('href="/products/tee/"');
		expect(grid).toContain('href="/products/cap/"');
		expect(grid).toContain('/img/tee.jpg');
		expect(grid).toContain('data-price-pending');
		expect(grid).not.toContain('animate-pulse'); // real cards, not the skeleton
		// The filter toggle's own label ("In stock only") is a control, not availability; it is on every shop render.
		const page = document.documentElement.outerHTML.split('In stock only').join('');
		expect(priceFree(page)).toEqual([]);
		expect(stockFree(page)).toEqual([]);
	});

	it('shell without a structure (failed read at render): the reserved skeleton grid, as before #412', async () => {
		const document = await render({ totalItems: 0, products: [], fallback: false, deferred: true });
		expect(document.querySelector('[data-listing-pending]')!.innerHTML).toContain('animate-pulse');
	});

	it('switch off: the loader listing renders with prices and the default in-stock filter, no pending markers', async () => {
		const document = await render({ totalItems: 2, products: full, fallback: false, deferred: false });
		const html = document.body.innerHTML;
		expect(html).toContain('Name tee');
		expect(html).toContain('44.67');
		expect(html).not.toContain('href="/products/cap/"'); // out of stock: hidden by the default in-stock filter
		expect(html).not.toContain('data-price-pending');
		expect(html).not.toContain('data-listing-pending');
	});
});
