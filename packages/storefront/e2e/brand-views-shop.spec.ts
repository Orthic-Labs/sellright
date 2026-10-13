import { test, expect } from './fixtures';
import { apiLog, STOCK_PATTERNS } from './support/api-log';

/**
 * Brand views PR2 (shop and product views on the gateway), compiled. Runs only against the PR2 fixture build with the API tap on:
 *
 *   SELLRIGHT_BRAND_SLOTS_DIR=src/components/slots/__fixtures__/brand-views-pr2
 *   SELLRIGHT_BRAND_DATA_DIR=src/components/slots/__fixtures__/brand-views-pr2-data   pnpm run e2e:build
 *   E2E_BRAND_VIEWS_PR2=1 E2E_API_TAP=1 npx playwright test e2e/brand-views-shop.spec.ts
 *
 * The fixture routes.json declares
 * shop.detailProducts e2e-shirt (deep stock) and e2e-out-of-stock-tee (on hand 0), productQuery ?style=, and the operational
 * aliases /checkout/fixture-link/ and /api/analytics/fixture-sink/.
 */
const VIEWS = process.env.E2E_BRAND_VIEWS_PR2 === '1';
const browserStock = (mark: number) => apiLog.since(mark, STOCK_PATTERNS.productStock, { origin: 'browser' });

test.describe('brand views PR2 (fixture build)', () => {
	test.skip(!VIEWS, 'needs E2E_BRAND_VIEWS_PR2=1 and a build with the PR2 fixture views and data: did not run, missing coverage');

	test('shop: one live read per view covering both detail products; selection reads nothing; add uses the server response and opens the drawer', async ({ apiProxyPage: page }) => {
		apiLog.require();
		const mark = apiLog.mark();
		await page.goto('/shop/');
		const view = page.getByTestId('view-shop');
		await expect(view).toHaveAttribute('data-detail-status', 'ok');
		await expect(view).toHaveAttribute('data-reason', 'select-product');
		await expect(page.getByTestId('view-shop-product-shirt')).toHaveAttribute('data-availability', 'in-stock', { timeout: 15_000 });
		await expect(page.getByTestId('view-shop-product-oos')).toHaveAttribute('data-availability', 'out-of-stock');
		const reads = await browserStock(mark);
		expect(reads.map((c) => c.path.split('/')[5]).sort()).toEqual(['e2e-out-of-stock-tee', 'e2e-shirt']);
		const before = apiLog.mark();
		await page.getByTestId('view-shop-product-oos').click();
		await expect(view).toHaveAttribute('data-reason', 'out-of-stock');
		await page.getByTestId('view-shop-add').click();
		await expect(page.getByTestId('view-shop-outcome')).toHaveText('rejected:not-eligible');
		await page.getByTestId('view-shop-product-shirt').click();
		await expect(view).toHaveAttribute('data-eligible', 'true');
		expect(await browserStock(before)).toHaveLength(0);
		await page.getByTestId('view-shop-add').click();
		await expect(page.getByTestId('view-shop-outcome')).toHaveText('added');
		await expect(page.getByRole('button', { name: /remove item/i }).first()).toBeVisible({ timeout: 10_000 });
		expect(await browserStock(before)).toHaveLength(0); // the add's own response is the live check: no extra stock read
	});

	test('shop: ?style= picks the initial product on the server', async ({ apiProxyPage: page }) => {
		await page.goto('/shop/?style=oos');
		await expect(page.getByTestId('view-shop')).toHaveAttribute('data-selected', 'oos');
		await expect(page.getByTestId('view-shop')).toHaveAttribute('data-reason', 'out-of-stock', { timeout: 15_000 });
	});

	test('shop: a query-only SPA navigation (?style=shirt → ?style=oos) is a new view: new focus from the query and one new read', async ({ apiProxyPage: page }) => {
		apiLog.require();
		await page.goto('/shop/?style=shirt');
		const view = page.getByTestId('view-shop');
		await expect(view).toHaveAttribute('data-eligible', 'true', { timeout: 15_000 });
		const mark = apiLog.mark();
		await page.getByTestId('view-shop-query-oos').click();
		await page.waitForURL(/\?style=oos$/);
		await expect(view).toHaveAttribute('data-selected', 'oos');
		await expect(view).toHaveAttribute('data-reason', 'out-of-stock', { timeout: 15_000 });
		expect((await browserStock(mark)).map((c) => c.path.split('/')[5]).sort()).toEqual(['e2e-out-of-stock-tee', 'e2e-shirt']);
	});

	test('product: declared head copy, platform breadcrumb and siblings; one live read; a forged call is invalid and reads nothing', async ({ apiProxyPage: page }) => {
		apiLog.require();
		const mark = apiLog.mark();
		await page.goto('/products/e2e-shirt/');
		await expect(page).toHaveTitle(/^The fixture shirt \| /);
		expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toMatch(/\/products\/e2e-shirt\/$/);
		await expect(page.getByTestId('view-product-crumb')).toHaveText('Home/Shop/Fixture shirt');
		await expect(page.getByTestId('view-product-siblings')).toHaveText('oos');
		await expect(page.getByTestId('view-product')).toHaveAttribute('data-eligible', 'true', { timeout: 15_000 });
		expect((await browserStock(mark)).map((c) => c.path.split('/')[5])).toEqual(['e2e-shirt']);
		const jsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
		expect(jsonLd.some((j) => j.includes('"FAQPage"'))).toBe(true);
		const before = apiLog.mark();
		await page.getByTestId('view-product-forge').click();
		await expect(page.getByTestId('view-product-outcome')).toHaveText('forged:invalid');
		expect(await browserStock(before)).toHaveLength(0);
	});

	test('product: an SPA navigation to a sibling (same component) is a new view with exactly one new read; the old view\'s state is gone', async ({ apiProxyPage: page }) => {
		apiLog.require();
		await page.goto('/products/e2e-shirt/');
		await expect(page.getByTestId('view-product')).toHaveAttribute('data-eligible', 'true', { timeout: 15_000 });
		const mark = apiLog.mark();
		await page.getByTestId('view-product-sibling-oos').click();
		await page.waitForURL(/\/products\/e2e-out-of-stock-tee\/$/);
		await expect(page.getByTestId('view-product')).toHaveAttribute('data-availability', 'out-of-stock', { timeout: 15_000 });
		await expect(page.getByTestId('view-product')).toHaveAttribute('data-eligible', 'false');
		expect((await browserStock(mark)).map((c) => c.path.split('/')[5])).toEqual(['e2e-out-of-stock-tee']);
	});

	test('product: an out-of-stock product shows out of stock from its live read and its add is refused', async ({ apiProxyPage: page }) => {
		await page.goto('/products/e2e-out-of-stock-tee/');
		await expect(page.getByTestId('view-product')).toHaveAttribute('data-availability', 'out-of-stock', { timeout: 15_000 });
		await expect(page.getByTestId('view-product')).toHaveAttribute('data-reason', 'out-of-stock');
		await expect(page.getByTestId('view-product-add')).toBeDisabled();
	});

	test('product: a missing product is a 404 with the missing view, Product Not Found + noindex, and no stock read', async ({ apiProxyPage: page }) => {
		apiLog.require();
		const mark = apiLog.mark();
		const res = await page.goto('/products/no-such-product-pr2/');
		expect(res?.status()).toBe(404);
		await expect(page.getByTestId('view-product-missing')).toBeVisible();
		await expect(page).toHaveTitle(/^Product Not Found/);
		expect(await page.locator('meta[name="robots"]').getAttribute('content')).toMatch(/^noindex/);
		await page.waitForLoadState('networkidle');
		expect(await browserStock(mark)).toHaveLength(0);
	});

	test('cart-link alias seeds the cart and lands on checkout; another /checkout/<segment>/ stays a 404', async ({ apiProxyPage: page, request }) => {
		const res = await request.get('/checkout/fixture-link/?products=E2E-SHIRT-1:2');
		expect(res.status()).toBe(200);
		expect(res.headers()['cache-control']).toMatch(/no-store/);
		await page.goto('/checkout/fixture-link/?products=E2E-SHIRT-1:2&utm_source=e2e');
		await page.waitForURL(/\/checkout\/\?utm_source=e2e$/, { timeout: 15_000 });
		expect((await request.get('/checkout/not-a-link/')).status()).toBe(404);
	});

	test('event sink: the alias and the built-in path accept browser events, refuse purchase, and 404 anything else', async ({ request }) => {
		const event = { type: 'ecommerce', event: { name: 'view_item', eventId: 'view_item_e2e', items: [{ item_id: 'E2E-SHIRT-1', quantity: 1 }], gtagSent: true } };
		for (const path of ['/api/analytics/fixture-sink/', '/api/analytics/events/']) {
			const ok = await request.post(path, { data: event });
			expect(ok.status(), path).toBe(202);
			expect(ok.headers()['cache-control']).toMatch(/no-store/);
			expect((await request.post(path, { data: { type: 'ecommerce', event: { ...event.event, name: 'purchase' } } })).status()).toBe(400);
			expect((await request.post(path, { data: { type: 'web-vitals' } })).status()).toBe(204);
		}
		expect((await request.post('/api/analytics/not-configured/', { data: event })).status()).toBe(404);
	});
});
