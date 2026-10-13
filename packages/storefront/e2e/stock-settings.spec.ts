import { test, expect } from './fixtures';
import { PRODUCT } from './support/api';
import { apiLog, STOCK_PATTERNS } from './support/api-log';

/**
 * The three platform stock settings (src/platform/stock-triggers.ts), compiled. Runs only against a build with the non-default
 * values and the API tap on:
 *
 *   VITE_SR_PDP_STOCK_TRIGGER=qinit VITE_SR_SHOP_STOCK_ON_LOAD=live VITE_SR_PDP_BFCACHE_REFRESH=true pnpm run e2e:build
 *   E2E_STOCK_SETTINGS=1 E2E_API_TAP=1 npx playwright test e2e/stock-settings.spec.ts
 *
 * The default build (every other spec, stock-parity included) keeps today's behaviour: qidle, manifest-only shop load, no bfcache read.
 */
const ON = process.env.E2E_STOCK_SETTINGS === '1';
const browser = { origin: 'browser' as const };

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

	test('pdp.stockRefreshTrigger=qinit: the PDP still reads live stock exactly once per load', async ({ apiProxyPage: page }) => {
		apiLog.require();
		const mark = apiLog.mark();
		await page.goto(`/products/${PRODUCT.shirt.slug}/`);
		await page.waitForLoadState('networkidle');
		expect((await apiLog.since(mark, STOCK_PATTERNS.productStock, browser)).length).toBe(1);
	});

	test('pdp.bfcacheRefresh=true: a persisted pageshow reads live stock again; a plain pageshow does not', async ({ apiProxyPage: page }) => {
		apiLog.require();
		await page.goto(`/products/${PRODUCT.shirt.slug}/`);
		await page.waitForLoadState('networkidle');
		let mark = apiLog.mark();
		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })));
		await page.waitForTimeout(1500);
		expect((await apiLog.since(mark, STOCK_PATTERNS.productStock, browser)).length).toBe(0);
		mark = apiLog.mark();
		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
		await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.productStock, browser)).length).toBe(1);
	});
});
