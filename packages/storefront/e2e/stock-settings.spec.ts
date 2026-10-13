import { test, expect } from './fixtures';
import { PRODUCT } from './support/api';
import { apiLog, STOCK_PATTERNS } from './support/api-log';

/**
 * The three platform stock settings (src/platform/stock-triggers.ts), compiled. Runs only against a build with the non-default values
 * and the API tap on, once without brand views (base shop and PDP) and once with the PR2 fixture views (brand shop and product view):
 *
 *   VITE_SR_PDP_STOCK_TRIGGER=qinit VITE_SR_SHOP_STOCK_ON_LOAD=live VITE_SR_PDP_BFCACHE_REFRESH=true [SELLRIGHT_BRAND_SLOTS_DIR=… SELLRIGHT_BRAND_DATA_DIR=…] pnpm run e2e:build
 *   E2E_STOCK_SETTINGS=1 E2E_API_TAP=1 npx playwright test e2e/stock-settings.spec.ts
 *
 * The default build (every other spec, stock parity included) keeps today's behaviour: qidle, manifest-only shop load, no bfcache read.
 */
const ON = process.env.E2E_STOCK_SETTINGS === '1';
const browser = { origin: 'browser' as const };
const pdp = `/products/${PRODUCT.shirt.slug}/`;

test.describe('stock settings (non-default build)', () => {
	test.skip(!ON, 'needs E2E_STOCK_SETTINGS=1 and a build with the non-default settings: did not run, missing coverage');

	test('shop.stockOnLoad=live: one live listing read per load, no toggle needed; a reload reads again', async ({ apiProxyPage: page }) => {
		apiLog.require();
		for (let round = 0; round < 2; round++) {
			const mark = apiLog.mark();
			if (round === 0) await page.goto('/shop/');
			else await page.reload();
			await page.waitForLoadState('networkidle');
			await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.shopCatalog, browser)).length).toBe(1);
		}
	});

	test('shop.stockOnLoad=live: a same-component SPA navigation (query only) is a new view with one new listing read', async ({ apiProxyPage: page }) => {
		apiLog.require();
		await page.goto('/shop/?style=shirt');
		await page.waitForLoadState('networkidle');
		const link = page.getByTestId('view-shop-query-oos');
		test.skip((await link.count()) === 0, 'the base shop has no query link: covered by the brand-view build run of this spec');
		const mark = apiLog.mark();
		await link.click();
		await page.waitForURL(/\?style=oos$/);
		await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.shopCatalog, browser)).length).toBe(1);
		await page.waitForLoadState('networkidle');
		expect((await apiLog.since(mark, STOCK_PATTERNS.shopCatalog, browser)).length).toBe(1);
	});

	test('pdp.stockRefreshTrigger=qinit: with idle never reached, the PDP still reads live stock, exactly once', async ({ apiProxyPage: page }) => {
		apiLog.require();
		// The browser never reports idle: a qidle-triggered read could not start. The qinit trigger fires when the document is ready.
		await page.addInitScript(() => {
			(window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = () => 0;
		});
		const mark = apiLog.mark();
		await page.goto(pdp);
		await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.productStock, browser)).length, { timeout: 15_000 }).toBe(1);
		await page.waitForLoadState('networkidle');
		expect((await apiLog.since(mark, STOCK_PATTERNS.productStock, browser)).length).toBe(1);
	});

	test('pdp.bfcacheRefresh=true: a persisted pageshow reads live stock again; a plain pageshow does not', async ({ apiProxyPage: page }) => {
		apiLog.require();
		await page.goto(pdp);
		await page.waitForLoadState('networkidle');
		const mark = apiLog.mark();
		// Both events go through the same listener, in order: had the plain one read, there would be two requests.
		await page.evaluate(() => {
			window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
			window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
		});
		await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.productStock, browser)).length).toBeGreaterThanOrEqual(1);
		await page.waitForLoadState('networkidle');
		expect((await apiLog.since(mark, STOCK_PATTERNS.productStock, browser)).length).toBe(1);
	});
});
