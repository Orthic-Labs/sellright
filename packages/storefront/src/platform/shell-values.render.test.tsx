// ADR-0001 lane S2: stock-absence and price-absence of every shell route's server output (SHELL_CACHE=1), and the values after the
// browser's read. Each shell route's loader value is built through the same shell function the loader applies, serialised as the page
// would serialise it, and checked for the fixture product's price (4567 cents, $45.67 / $46) and any stock value; the matching
// component renders are checked as HTML. A positive control proves the fixture values are detectable when present.
import { QwikRouterMockProvider } from '@qwik.dev/router';
import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it } from 'vitest';
import type { CatalogListItem, CatalogProduct } from '~/sellright/types/catalog';
import ProductCard from '~/components/products/ProductCard';
import Price from '~/components/products/Price';
import { ProductMobileBar } from '~/routes/products/[...slug]/ProductMobileBar';
import { buildModelProduct, projectSummary, projectViewProduct } from './controllers/product-model';
import { hasPendingValues, pickLiveSource } from './controllers/configurator-model';
import { projectFeatured, projectProductTiles } from './controllers/project';
import { shellConfiguratorDetail, type ConfiguratorDetail } from './configurator-detail';
import { shellBrandProductDetail, type BrandProductDetail } from './product-detail';
import { shellProductResult, variantPricesOf, type ProductLoaderResult } from './product';
import { shellFeaturedItem, shellHomeProduct } from './home';
import { relatedRow, shellRelatedRow, relatedPricesOf } from './product-related-model';
import { fillJsonLdOffers, jsonLdTextWithOffers, productGroupSchema, productOgMeta, withoutOffers } from './product-jsonld';
import { applyVariantPrices, cardState, redactListItem, valuesBySlug, withCardValues } from './live-values';
import { shellShopItem } from './shop';
import { CHECKOUT_SHELL, displayServerCart, isCheckoutShell } from '~/routes/checkout/summary-cart';

const PRICE = 4567;
/** Every rendering of the fixture price, and every stock value a shell could leak. */
const PRICE_STRINGS = ['4567', '45.67', '$46', '$45', '4467', '44.67'];
const STOCK_STRINGS = ['"inStock":true', 'schema.org/InStock', '"InStock"', 'In stock', 'in-stock', 'Sold Out', 'OutOfStock', '"catalogInStock":true', '"catalogInStock":false', 'IN_STOCK', 'OUT_OF_STOCK'];
const priceFree = (text: string) => PRICE_STRINGS.filter((s) => text.includes(s));
const stockFree = (text: string) => STOCK_STRINGS.filter((s) => text.includes(s));

const catalogProduct = (slug: string): CatalogProduct =>
	({
		slug, name: `Name ${slug}`, description: '<p>About</p>', tags: ['tee'], status: 'active', seoTitle: null, seoDescription: null, currency: 'USD', images: ['/a.jpg'],
		variants: ['Small', 'Medium'].map((size, i) => ({
			id: `${slug}-${i}`, sku: `${slug}-${i}`, name: size, price: PRICE, salePrice: PRICE - 100, preOrderPrice: null, shipDate: null, compareAtPrice: PRICE + 1000,
			isPreOrder: false, enabled: true, fulfillmentType: 'physical', appKey: null, inStock: true, availableQuantity: 5, assets: [],
			options: [{ id: `o${i}`, code: `o${i}`, name: size, position: i, group: { id: 'g', code: 'g', name: 'Size', position: 0 } }],
		})),
	}) as unknown as CatalogProduct;
const model = (slug: string, key = slug) => buildModelProduct(catalogProduct(slug), { key, href: `/shop/${slug}/`, rating: null, productId: null, catalogInStock: true });
const listItem = (slug: string, inStock = true): CatalogListItem => ({
	slug, name: `Name ${slug}`, status: 'active', inStock, tags: ['tee'], minPrice: PRICE, maxPrice: PRICE + 1000, image: null,
	pricingVariant: { sku: slug, price: PRICE, salePrice: PRICE - 100, preOrderPrice: null, isPreOrder: false, shipDate: null, shipDateLabel: null },
});

const html = async (node: unknown) => (await ssrRenderToDom(<QwikRouterMockProvider>{node as never}</QwikRouterMockProvider>, {})).document.body.innerHTML;

describe('positive control: the fixture values are detected when present', () => {
	it('an unredacted detail and card leak price and stock', async () => {
		const full = JSON.stringify({ m: model('tee'), l: listItem('tee') });
		expect(priceFree(full).length).toBeGreaterThan(0);
		expect(stockFree(full).length).toBeGreaterThan(0);
		const card = await html(<ProductCard slug="tee" name="Tee" price={PRICE} inStock={false} />);
		expect(priceFree(card)).toContain('45.67');
		expect(stockFree(card)).toContain('Sold Out');
	});
});

describe('/ (home): spotlight, feature strip and featured tiles', () => {
	it('base home products: no price, no stock level', () => {
		const p = {
			id: '1', name: 'Tee', slug: 'tee', category: null, description: null, featuredAsset: null,
			variants: [{ id: 'v', name: 'S', price: PRICE, priceWithTax: PRICE, stockLevel: 'IN_STOCK', options: [], featuredAsset: null, customFields: { preOrderPrice: PRICE, salePrice: PRICE - 100, shipDate: null, shipDateLabel: null, isPreOrder: false } }],
		};
		const shell = JSON.stringify(shellHomeProduct(p as never));
		expect(priceFree(shell)).toEqual([]);
		expect(stockFree(shell)).toEqual([]);
	});
	it('featured tiles (base grid and brand ListingCard projection): no price, no stock', () => {
		const tile = { slug: 'tee', productName: 'Tee', productAsset: null, priceWithTax: { min: PRICE, max: PRICE }, inStock: true, productId: 'p', productVariantId: 'v', currencyCode: 'USD', facetValues: [] };
		const shell = shellFeaturedItem(tile as never);
		expect(priceFree(JSON.stringify(shell))).toEqual([]);
		expect(stockFree(JSON.stringify(shell))).toEqual([]);
		expect(priceFree(JSON.stringify(projectFeatured([shell])))).toEqual([]);
		expect(projectProductTiles([shell])[0]).toMatchObject({ price: 0, inStock: false });
	});
	it('brand spotlight model (route.home): no price, no stock hint; the view says pricePending', () => {
		const shell = { detail: [model('tee')].map((m) => shellConfiguratorDetail({ listing: [], detail: [m], detailStatus: 'ok', source: 'manifest' }).detail[0]), source: 'manifest' as const };
		const text = JSON.stringify(shell);
		expect(priceFree(text)).toEqual([]);
		expect(stockFree(text)).toEqual([]);
		expect(projectViewProduct(shell.detail[0], undefined, [null]).pricePending).toBe(true);
		expect(hasPendingValues(shell, 'spotlight')).toBe(true);
	});
	it('rendered tiles (pending): no price text, no Sold Out / Pre-order / Sale; space held', async () => {
		const out = await html(<ProductCard slug="tee" name="Tee" price={0} inStock={false} pending pricePending salePrice={null} />);
		expect(priceFree(out)).toEqual([]);
		expect(stockFree(out)).toEqual([]);
		expect(out).toContain('data-price-pending');
		expect(out).toContain('View product');
	});
});

describe('/shop/ (base and branded)', () => {
	const detail: ConfiguratorDetail = { listing: [{ slug: 'tee', name: 'Tee', href: '/shop/tee/', image: null, priceCents: PRICE, currencyCode: 'USD', availability: 'in-stock' }], detail: [model('tee')], detailStatus: 'ok', source: 'manifest' };
	it('branded shop loader value: no listing (stock-bearing), detail without price or stock hint', () => {
		const shell = shellConfiguratorDetail(detail);
		const text = JSON.stringify(shell);
		expect(shell.listing).toEqual([]);
		expect(priceFree(text)).toEqual([]);
		expect(stockFree(text)).toEqual([]);
	});
	it('shop head ProductGroup JSON-LD of a shell model: no offers, no price', () => {
		const shell = shellConfiguratorDetail(detail);
		const schema = JSON.stringify(productGroupSchema(shell.detail[0], { siteOrigin: 'https://x.test', brandName: 'B' }));
		expect(schema).not.toContain('Offer');
		expect(priceFree(schema)).toEqual([]);
		// control: the full model states its offer
		expect(JSON.stringify(productGroupSchema(detail.detail[0], { siteOrigin: 'https://x.test', brandName: 'B' }))).toContain('44.67'); // effective (sale) price
	});
	it('after the browser read the configurator sells from the live value of the same products only', () => {
		const shell = shellConfiguratorDetail(detail);
		expect(pickLiveSource(shell, detail, 'shop')).toBe(detail);
		const other: ConfiguratorDetail = { ...detail, detail: [model('other')] };
		expect(pickLiveSource(shell, other, 'shop')).toBe(shell);
		expect(pickLiveSource(detail, detail, 'shop')).toBe(detail); // switch off: the loader value, no live read applies
	});
});

describe('product pages (base /products/:slug/ and brand productPath /shop/:slug/)', () => {
	const base: ProductLoaderResult = { product: catalogProduct('tee'), source: 'manifest', warning: null, productId: null, rating: null, catalogInStock: true };
	it('base PDP loader value: no price (incl. compareAtPrice), no stock hint; stock stays fail-closed', () => {
		const shell = shellProductResult(base);
		const text = JSON.stringify({ ...shell, product: { ...shell.product, variants: shell.product.variants.map(({ inStock: _i, availableQuantity: _a, ...v }) => v) } });
		expect(priceFree(text)).toEqual([]);
		expect(stockFree(text)).toEqual([]);
		expect(shell.valuesPending).toBe(true);
		expect(shell.catalogInStock).toBeNull();
	});
	it('base PDP: prices land after the client read', () => {
		const shell = shellProductResult(base);
		const merged = applyVariantPrices(shell.product.variants, variantPricesOf(base.product));
		expect(merged.map((v) => v.price)).toEqual([PRICE, PRICE]);
	});
	it('brand product detail: product and siblings without price or stock hint; og price tag absent', () => {
		const found: BrandProductDetail = { state: 'found', product: model('tee'), siblings: [model('long')], breadcrumbs: [], source: 'manifest' };
		const shell = shellBrandProductDetail(found);
		const text = JSON.stringify(shell);
		expect(priceFree(text)).toEqual([]);
		expect(stockFree(text)).toEqual([]);
		if (shell.state !== 'found') throw new Error('found');
		expect(projectSummary(shell.siblings[0]).pricePending).toBe(true);
		expect(productOgMeta(null, shell.product, 'B').price).toBeUndefined();
		expect(productOgMeta(null, found.state === 'found' ? found.product : shell.product, 'B').price).toBe('44.67');
	});
	it('PDP JSON-LD: the shell has no offers; the client read fills them', () => {
		const api = { '@context': 'https://schema.org', '@type': 'Product', name: 'Tee', offers: { '@type': 'Offer', price: '45.67', availability: 'https://schema.org/InStock' } };
		const shell = JSON.stringify(withoutOffers(api));
		expect(priceFree(shell)).toEqual([]);
		expect(stockFree(shell)).toEqual([]);
		const filled = jsonLdTextWithOffers(shell, api.offers);
		expect(filled).toContain('45.67');
		expect(filled).toContain('InStock');
		expect(jsonLdTextWithOffers('{"@type":"BreadcrumbList"}', api.offers)).toBeNull();
		const scripts = [{ textContent: shell }, { textContent: '{"@type":"BreadcrumbList"}' }];
		expect(fillJsonLdOffers({ querySelectorAll: () => scripts } as never, api.offers)).toBe(1);
		expect(scripts[0].textContent).toContain('45.67');
	});
	it('related row: no prices in the shell, prices from the live read', () => {
		const row = relatedRow([listItem('tee'), listItem('cap')], 'tee');
		const shell = shellRelatedRow(row);
		expect(priceFree(JSON.stringify(shell))).toEqual([]);
		expect(relatedPricesOf(row)).toEqual({ cap: PRICE });
	});
	it('mobile bar: placeholder while pending, the price once read', async () => {
		const props = {
			product: { name: 'Tee' }, selectedVariant: { value: undefined }, displayPrice: { value: PRICE }, allVariantsSoldOut: { value: false }, waitlistAvailable: false,
			isPreOrder: { value: false }, showFromPrefix: { value: false }, isAddingToCart: { value: false }, isOutOfStock: { value: false }, ctaClass: { value: 'sr-cta-btn ready' },
			ctaDisabled: { value: false }, showCtaTooltip: { value: false }, ctaTooltipFading: { value: false },
		};
		const pending = (await ssrRenderToDom(<ProductMobileBar {...props} displayPrice={{ value: 0 }} pricesPending={{ value: true }} />, {})).document.body.innerHTML;
		expect(pending).toContain('data-price-pending');
		expect(pending).not.toContain('$0');
		const ready = (await ssrRenderToDom(<ProductMobileBar {...props} pricesPending={{ value: false }} />, {})).document.body.innerHTML;
		expect(ready).toContain('$46');
	});
});

describe('/collections/* cards', () => {
	it('loader items: no price, no stock; values appear after the read (fail closed for a slug it omitted)', async () => {
		const shell = [listItem('tee'), listItem('cap', false)].map(redactListItem);
		const text = JSON.stringify(shell);
		expect(priceFree(text)).toEqual([]);
		expect(stockFree(text)).toEqual([]);
		const pendingHtml = await html(<>{shell.map((p) => <ProductCard key={p.slug} slug={p.slug} name={p.name} price={p.minPrice} inStock={p.inStock} {...cardState('loading', true)} />)}</>);
		expect(priceFree(pendingHtml)).toEqual([]);
		expect(stockFree(pendingHtml)).toEqual([]);

		const live = valuesBySlug([listItem('tee')]);
		const after = shell.map((p) => withCardValues(p, live));
		const readyHtml = await html(<>{after.map((p) => <ProductCard key={p.slug} slug={p.slug} name={p.name} price={p.pricingVariant?.price ?? p.minPrice} salePrice={p.pricingVariant?.salePrice ?? null} inStock={p.inStock} {...cardState('ready', true)} />)}</>);
		expect(readyHtml).toContain('44.67'); // tee's live (sale) price
		expect(readyHtml).toContain('Sold Out'); // cap: omitted by the read, fail closed
	});
});

describe('Price placeholder', () => {
	it('pending renders digit-free reserved text with the price class', async () => {
		const out = await html(<Price price={null} forcedClass="po-price" pending />);
		expect(priceFree(out)).toEqual([]);
		expect(out).toContain('po-price');
		expect(out).toContain('data-price-pending');
		expect(await html(<Price price={PRICE} forcedClass="po-price" />)).toContain('45.67');
	});
});

// ---------------------------------------------------------------------------------------------------- #412: shell values of shop and checkout
// (the page renders: routes/shop/shop-shell.render.test.tsx, components/checkout/checkout-shell.render.test.tsx)

describe('/shop/ shell items (#412)', () => {
	it('keep the structure only: slug, name, image, tags; no price, no stock value; no unknown field rides through', () => {
		const shell = [listItem('tee'), listItem('cap', false)].map(shellShopItem);
		const text = JSON.stringify(shell);
		expect(priceFree(text)).toEqual([]);
		expect(stockFree(text)).toEqual([]);
		expect(shell[0]).toMatchObject({ slug: 'tee', name: 'Name tee', tags: ['tee'], image: null, minPrice: null, maxPrice: null, pricingVariant: null, inStock: false });
		expect(Object.keys(shellShopItem({ ...listItem('tee'), availableQuantity: 5 } as CatalogListItem))).not.toContain('availableQuantity');
	});
});

describe('/checkout/ shell loader value (#412)', () => {
	it('the marker carries no cart, no price and no identity, and is never shown as a cart', () => {
		expect(JSON.stringify(CHECKOUT_SHELL)).toBe('{"shell":true}');
		expect(isCheckoutShell(CHECKOUT_SHELL)).toBe(true);
		expect(displayServerCart(CHECKOUT_SHELL)).toBeNull();
		expect(isCheckoutShell(null)).toBe(false);
	});
});
