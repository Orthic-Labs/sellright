import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { CATALOG_DIR, SHOP_API_URL, STORE_URL } from './support/env.mjs';
import { clientIp } from './support/api';
import { apiLog, STOCK_PATTERNS } from './support/api-log';
import { addToCart, fillShipping, goToCheckout, placeOrderButton } from './support/flows';
import { createStockProduct, currentGeneration, setOnHand } from './support/stock';
import { brand } from './support/parity-brands';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * STOCK PARITY SUITE (plan A9) — base brand. Observes API-SIDE requests through the API tap (browser calls, the
 * storefront server's own SSR/JSON-LD calls) and never trusts rendered state alone. Each scenario fails if any cache,
 * TTL, debounce or session guard sits between the shopper and live stock (CLAUDE.md "Stock Architecture (LOCKED)").
 *
 * Needs E2E_API_TAP=1 (support/run-parity.sh sets it). Without the tap every test here is SKIPPED — a skip is reported
 * as missing coverage, never as a pass.
 *
 * NEVER RUN when this file was written: selectors and timings follow existing specs (checkout-flow.spec.ts,
 * support/flows.ts) and the source, but the first run may need adjustment. A failure of a scenario that states a
 * locked rule is a FINDING to report, not a test defect to weaken away (see the A8 open questions in the plan).
 *
 * Implemented here: 1 (same-document + reload), 2, 3a/3b/3c, 4, 5, 6, 8, 10c, 12, 13 (base). Static scenarios 9 (publisher
 * source), 10a/b/d, 12 (static), 14, 17 (structural) live in unit suites that run with `pnpm test`:
 *   packages/api/src/manifest/{stock-hook,no-search-index}.test.ts, packages/storefront/src/services/stock-guards.test.ts.
 * NOT implemented (blocked): 7 (needs an option-group product seed), 11 and 17-dynamic (reader contract A4 / owner
 * decision O2), 15 (A9a document cache headers), 16 and 18 (owner decision O1, Rotten product route).
 */
test.skip(!apiLog.enabled, 'stock parity observes API-side requests: needs E2E_API_TAP=1 (api tap). Did not run: missing coverage, not a pass');

const stockCalls = (mark: number) => apiLog.since(mark, STOCK_PATTERNS.productStock, { origin: 'browser' });

// ── page-state helpers ───────────────────────────────────────────────────────────────────────────────────────────
/** Mirrors support/flows.ts addToCart's reading of the PDP: an enabled "Add to cart", or the "Select options" route
 *  through an enabled priced variant button (single-variant products). A disabled shell is not purchasable. */
async function purchasable(page: Page): Promise<boolean> {
	const add = page.getByRole('button', { name: /^add to cart$/i });
	if ((await add.count()) > 0 && (await add.first().isEnabled())) return true;
	const select = await page.getByRole('button', { name: /select options/i }).isVisible().catch(() => false);
	return select && (await page.locator('button:not([disabled])').filter({ hasText: '$' }).count()) > 0;
}
const expectPurchasable = (page: Page) => expect.poll(() => purchasable(page), { timeout: 20_000 }).toBe(true);
const expectNotPurchasable = async (page: Page) => {
	await expect.poll(() => purchasable(page), { timeout: 20_000 }).toBe(false);
	await expect(page.locator('body')).toContainText(/sold out|out of stock/i);
};

const markDocument = (page: Page, id: string) => page.evaluate((v) => { (window as unknown as { __parityDoc?: string }).__parityDoc = v; }, id);
const sameDocument = (page: Page) => page.evaluate(() => (window as unknown as { __parityDoc?: string }).__parityDoc);

/** SPA navigation (no document load) to the shop via the header link. */
async function spaToShop(page: Page) {
	await page.locator('a[href^="/shop"]').first().click();
	await page.waitForURL(/\/shop\/?$/);
	await page.waitForLoadState('networkidle');
}
/** SPA navigation to a product via its shop card; unchecks "in stock only" first when the card is hidden by it. */
async function spaToProductFromShop(page: Page, slug: string) {
	const card = page.locator(`a[href*="${slug}"]`).first();
	if (!(await card.isVisible().catch(() => false))) await page.locator('input[type="checkbox"]').first().uncheck({ force: true });
	await expect(card).toBeVisible();
	await card.click();
	await page.waitForURL(new RegExp(`/products/${slug}/?$`));
}

// ── 1. same-document revisit with a change in between ─────────────────────────────────────────────────────────────
test.describe('1. PDP revisit with stock changed in between', () => {
	test('1a same document: SPA away and back (no reload) issues a NEW live stock call and follows the change, both directions', async ({ apiProxyPage: page, api }) => {
		const p = await createStockProduct(api, 'rev', 5);
		await page.goto(brand.pdpPath(p.slug));
		await page.waitForLoadState('networkidle');
		await expectPurchasable(page);
		await markDocument(page, 'doc-1');

		for (const [onHand, soldOut] of [[0, true], [5, false]] as const) {
			await spaToShop(page);
			await setOnHand(api, p.sku, onHand);
			const mark = apiLog.mark();
			await spaToProductFromShop(page, p.slug);
			await page.waitForLoadState('networkidle');
			expect(await sameDocument(page), 'must still be the first document (no reload happened)').toBe('doc-1');
			await expect.poll(async () => (await stockCalls(mark)).length, { message: `revisit with onHand=${onHand} must issue its own live stock call` }).toBeGreaterThanOrEqual(1);
			if (soldOut) await expectNotPurchasable(page); else await expectPurchasable(page);
		}
	});

	test('1b reload: each full load issues its own live stock call and follows the change, both directions', async ({ apiProxyPage: page, api }) => {
		const p = await createStockProduct(api, 'reload', 5);
		for (const [onHand, soldOut] of [[5, false], [0, true], [5, false], [0, true]] as const) {
			await setOnHand(api, p.sku, onHand);
			const mark = apiLog.mark();
			await page.goto(brand.pdpPath(p.slug));
			await page.waitForLoadState('networkidle');
			await expect.poll(async () => (await stockCalls(mark)).length).toBeGreaterThanOrEqual(1);
			if (soldOut) await expectNotPurchasable(page); else await expectPurchasable(page);
		}
	});
});

// ── 2. repeated shop toggles ──────────────────────────────────────────────────────────────────────────────────────
test('2. repeated "in stock only" toggles each issue their own live catalog call and the list follows (stock changed between)', async ({ apiProxyPage: page, api }) => {
	const p = await createStockProduct(api, 'toggle', 5);
	await page.goto(brand.shopPath);
	await page.waitForLoadState('networkidle');
	const toggle = page.locator('input[type="checkbox"]').first();
	const card = page.locator(`a[href*="${p.slug}"]`);
	await expect(card.first()).toBeVisible();

	// [action, stock BEFORE the toggle, card expected visible after it]. "in stock only" starts ON.
	const steps = [
		{ to: 'off' as const, onHand: 5, visible: true },
		{ to: 'on' as const, onHand: 0, visible: false },
		{ to: 'off' as const, onHand: 5, visible: true },
		{ to: 'on' as const, onHand: 5, visible: true },
	];
	let total = 0;
	for (const [i, s] of steps.entries()) {
		await setOnHand(api, p.sku, s.onHand);
		const mark = apiLog.mark();
		if (s.to === 'off') await toggle.uncheck({ force: true }); else await toggle.check({ force: true });
		await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.shopCatalog, { origin: 'browser' })).length, { message: `toggle ${i + 1} must issue its own call` }).toBeGreaterThanOrEqual(1);
		total += (await apiLog.since(mark, STOCK_PATTERNS.shopCatalog, { origin: 'browser' })).length;
		await expect(card, `toggle ${i + 1} (${s.to}, onHand ${s.onHand})`).toHaveCount(s.visible ? 1 : 0);
	}
	expect(total).toBeGreaterThanOrEqual(steps.length);
});

// ── 3. cart open, checkout entry, pre-submit ──────────────────────────────────────────────────────────────────────
test.describe('3. cart and checkout stock checks', () => {
	const cartButton = (page: Page) => page.getByRole('button', { name: /\d+ items? in cart/i });
	const droppedNotice = /no longer available|out of stock|sold out|unavailable|removed/i;

	test('3a cart open: every open issues its own live read and shows the change; sequential opens never coalesce', async ({ apiProxyPage: page, api }) => {
		const p = await createStockProduct(api, 'cart', 5);
		await addToCart(page, p.slug); // the drawer is open after adding

		await cartButton(page).click(); // close
		let mark = apiLog.mark();
		await cartButton(page).click(); // open #1
		await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.cartRead, { origin: 'browser' })).length).toBeGreaterThanOrEqual(1);

		await cartButton(page).click(); // close
		await setOnHand(api, p.sku, 0);
		mark = apiLog.mark();
		await cartButton(page).click(); // open #2: a NEW call, not a reuse of #1
		await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.cartRead, { origin: 'browser' })).length).toBeGreaterThanOrEqual(1);
		await expect.poll(async () =>
			(await page.getByRole('button', { name: /remove item/i }).count()) === 0 || droppedNotice.test(await page.locator('body').innerText()),
		{ message: 'the cart must show the sold-out line as unavailable/removed' }).toBe(true);
	});

	test('3b checkout entry: every entry (SPA click and full load) issues its own live cart read', async ({ apiProxyPage: page, api }) => {
		const p = await createStockProduct(api, 'entry', 5);
		await addToCart(page, p.slug);
		let mark = apiLog.mark();
		await goToCheckout(page);
		await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.cartRead, { origin: 'browser' })).length, { message: 'entry via the cart button' }).toBeGreaterThanOrEqual(1);

		await setOnHand(api, p.sku, 0);
		mark = apiLog.mark();
		await page.goto(brand.checkoutPath);
		await page.waitForLoadState('networkidle');
		await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.cartRead, { origin: 'browser' })).length, { message: 'second entry after the stock changed' }).toBeGreaterThanOrEqual(1);
		await expect.poll(async () => droppedNotice.test(await page.locator('body').innerText()) || (await placeOrderButton(page).count()) === 0 || !(await placeOrderButton(page).isEnabled().catch(() => true))).toBe(true);
	});

	test('3c-i submit with stock gone is refused by the live server check: 409, no order, the UI says so', async ({ apiProxyPage: page, api }) => {
		const p = await createStockProduct(api, 'submit', 1);
		await addToCart(page, p.slug);
		await goToCheckout(page);
		await fillShipping(page, `${p.slug}@e2e.example.net`);
		await setOnHand(api, p.sku, 0); // the last unit sold elsewhere after the shopper reached PLACE ORDER
		const response = page.waitForResponse((r) => r.url().includes('/v1/shop/checkout') && r.request().method() === 'POST');
		await placeOrderButton(page).click();
		expect((await response).status(), 'POST /v1/shop/checkout must refuse an out-of-stock line').toBe(409);
		await expect(page.locator('body')).toContainText(droppedNotice);
		await expect(page).not.toHaveURL(/confirmation/);
	});

	// KNOWN GAP (found by reading the code, not by running): CLAUDE.md layer 4 says refreshCartStock also runs "inside
	// placeOrder before submit". In the base, useCheckout.placeOrder → srPlaceOrder goes straight to POST /checkout, and
	// the only refreshCartStock calls are checkout entry (routes/checkout/index.tsx:224) and after a stock conflict (:380).
	// The server-side 409 above still protects the sale. `test.fail()` keeps the suite green while the gap exists and
	// turns RED the moment a pre-submit read appears — then delete the `test.fail()` line. Report to Adrian; not fixed here.
	test('3c-ii a live cart read is issued BEFORE the order-creating POST (locked rule, layer 4) — known gap on the base', async ({ apiProxyPage: page, api }) => {
		test.fail(true, 'base placeOrder has no pre-submit refreshCartStock (see comment above); expected to fail until one exists');
		const p = await createStockProduct(api, 'presub', 3);
		await addToCart(page, p.slug);
		await goToCheckout(page);
		await fillShipping(page, `${p.slug}@e2e.example.net`);
		await page.waitForLoadState('networkidle');
		const mark = apiLog.mark();
		const response = page.waitForResponse((r) => r.url().includes('/v1/shop/checkout') && r.request().method() === 'POST');
		await placeOrderButton(page).click();
		await response;
		const calls = await apiLog.since(mark);
		const post = calls.find((c) => c.method === 'POST' && STOCK_PATTERNS.checkout.test(c.path));
		expect(post, 'the order POST must be in the log').toBeTruthy();
		expect(calls.some((c) => c.method === 'GET' && STOCK_PATTERNS.cartRead.test(c.path) && c.startedAt < post!.startedAt), 'a live cart read must start before the order POST').toBe(true);
	});
});

// ── 4. no persistent browser state for stock ──────────────────────────────────────────────────────────────────────
test('4. no stock in sessionStorage/localStorage after a PDP visit; reload with and without storage both issue the live call', async ({ apiProxyPage: page, api }) => {
	const p = await createStockProduct(api, 'store', 5);
	let mark = apiLog.mark();
	await page.goto(brand.pdpPath(p.slug));
	await page.waitForLoadState('networkidle');
	await expectPurchasable(page);
	await expect.poll(async () => (await stockCalls(mark)).length).toBeGreaterThanOrEqual(1);

	const dump = await page.evaluate(() => ({ session: Object.entries(sessionStorage), local: Object.entries(localStorage) }));
	for (const [key] of [...dump.session, ...dump.local]) expect(key, 'no storage key may name stock').not.toMatch(/stock|inventory|availab/i);
	expect(JSON.stringify(dump), 'no storage value may carry a stock level').not.toMatch(/stockLevel|inStock|availableQuantity/);

	mark = apiLog.mark();
	await page.reload();
	await page.waitForLoadState('networkidle');
	await expect.poll(async () => (await stockCalls(mark)).length, { message: 'reload with storage intact' }).toBeGreaterThanOrEqual(1);

	await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); });
	mark = apiLog.mark();
	await page.reload();
	await page.waitForLoadState('networkidle');
	await expect.poll(async () => (await stockCalls(mark)).length, { message: 'reload after clearing storage' }).toBeGreaterThanOrEqual(1);
});

// ── 5. PDP shell ──────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('5. PDP shell', () => {
	test('5a document HTML with JavaScript disabled never offers an enabled add-to-cart (stock ships as 0)', async ({ browser, api }) => {
		const p = await createStockProduct(api, 'shell', 5); // really in stock: a leak would show as purchasable
		const context = await browser.newContext({ javaScriptEnabled: false });
		try {
			const page = await context.newPage();
			await page.goto(`${STORE_URL}${brand.pdpPath(p.slug)}`);
			await expect(page.locator('h1').first()).toBeVisible();
			expect(await page.locator('button:not([disabled])').filter({ hasText: /^\s*add to cart\s*$/i }).count()).toBe(0);
			expect(await purchasable(page)).toBe(false);
		} finally {
			await context.close();
		}
	});

	test('5b the shell paints while the live stock request is still pending; stock then enables it (shell time independent of the stock endpoint)', async ({ apiProxyPage: page, api }) => {
		const p = await createStockProduct(api, 'gate', 5);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		// Registered after the proxy, so it runs first and hands the request on (fallback) once the test releases it.
		await page.route((url) => STOCK_PATTERNS.productStock.test(url.pathname), async (route) => { await gate; await route.fallback(); });
		await page.goto(brand.pdpPath(p.slug), { waitUntil: 'domcontentloaded' });
		await expect(page.locator('h1').first()).toBeVisible();
		expect(await purchasable(page), 'while the stock call is held, the shell must stay fail-closed').toBe(false);
		release();
		await expectPurchasable(page);
	});
});

// ── 6. server-side requests (JSON-LD) ─────────────────────────────────────────────────────────────────────────────
test('6. every PDP document request issues its own JSON-LD call and availability follows stock — same server process, no restart', async ({ api, request }) => {
	const p = await createStockProduct(api, 'jsonld', 5);
	const availability = (html: string) => /"availability"\s*:\s*"[^"]*\/(InStock|OutOfStock|PreOrder|LimitedAvailability|SoldOut|Discontinued|BackOrder|InStoreOnly|OnlineOnly|PreSale)"/.exec(html)?.[1];
	const mark = apiLog.mark();
	let requests = 0;
	for (const [onHand, expected] of [[5, 'InStock'], [0, 'OutOfStock'], [5, 'InStock'], [0, 'OutOfStock']] as const) {
		await setOnHand(api, p.sku, onHand);
		const res = await request.get(brand.pdpPath(p.slug));
		requests++;
		expect(res.status()).toBe(200);
		expect(availability(await res.text()), `JSON-LD availability after onHand=${onHand}`).toBe(expected);
	}
	const calls = await apiLog.since(mark, STOCK_PATTERNS.jsonLd, { origin: 'server' });
	expect(calls.length, 'each document request must issue its own server-side JSON-LD call').toBeGreaterThanOrEqual(requests);
});

// ── 8. fail closed ────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('8. fail closed: a broken live stock answer never makes the product purchasable', () => {
	const modes: Array<{ name: string; handle: (route: import('@playwright/test').Route, path: string) => Promise<void> }> = [
		{ name: '500', handle: (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"BOOM"}}' }) },
		{ name: 'timeout / aborted', handle: (r) => r.abort('timedout') },
		{ name: 'empty body', handle: (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '' }) },
		{
			name: 'variant omitted',
			handle: async (r, path) => {
				const live = await fetch(SHOP_API_URL + path, { headers: { 'x-real-ip': clientIp() } });
				const body = (await live.json()) as { variants?: unknown[] };
				await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...body, variants: [] }) });
			},
		},
	];
	for (const mode of modes) {
		test(`8 ${mode.name}`, async ({ apiProxyPage: page, api }) => {
			const p = await createStockProduct(api, 'closed', 5); // truly in stock: only a fail-open bug shows it as purchasable
			await page.route((url) => STOCK_PATTERNS.productStock.test(url.pathname), (route) => {
				const u = new URL(route.request().url());
				return mode.handle(route, u.pathname + u.search);
			});
			await page.goto(brand.pdpPath(p.slug));
			await page.waitForLoadState('networkidle');
			await page.waitForTimeout(1_500); // let the failed refresh settle
			expect(await purchasable(page), `stock answer "${mode.name}" must leave the PDP fail-closed`).toBe(false);
			await expect(page.getByRole('button', { name: /^add to cart$/i })).toHaveCount(0);
		});
	}
});

// ── 10c. burst: the final manifest equals the final database state (needs the real publisher) ─────────────────────
test('10c after a burst of real stock changes the published manifest equals the final database state', async ({ api }) => {
	test.skip(!CATALOG_DIR, 'needs E2E_CATALOG_DIR (the real publisher): did not run, missing coverage');
	const p = await createStockProduct(api, 'burst', 5);
	for (const onHand of [0, 3, 0, 4, 0, 2, 0]) await setOnHand(api, p.sku, onHand); // final state: sold out
	const live = await api.stock(p.sku);
	expect(live.available).toBe(0);

	const inStockInManifest = (): boolean | undefined => {
		const gen = currentGeneration();
		if (!gen) return undefined;
		const catalog = JSON.parse(readFileSync(join(gen.dir, 'shop-catalog.json'), 'utf8')) as { products: Array<{ slug: string; inStock?: boolean }> };
		return catalog.products.find((x) => x.slug === p.slug)?.inStock;
	};
	await expect.poll(inStockInManifest, { timeout: 30_000, message: 'intermediate generations may be skipped; the last one must show the final state' }).toBe(false);
	await new Promise((r) => setTimeout(r, 2_000));
	expect(inStockInManifest(), 'and it must stay there (no late trailing generation reverts it)').toBe(false);
});

// ── 12. no focus / visibility refresh ─────────────────────────────────────────────────────────────────────────────
test('12. visibilitychange and focus trigger no stock request (PDP and shop)', async ({ apiProxyPage: page, api }) => {
	const p = await createStockProduct(api, 'focus', 5);
	for (const path of [brand.pdpPath(p.slug), brand.shopPath]) {
		await page.goto(path);
		await page.waitForLoadState('networkidle');
		const mark = apiLog.mark();
		await page.evaluate(() => {
			document.dispatchEvent(new Event('visibilitychange'));
			window.dispatchEvent(new Event('focus'));
			window.dispatchEvent(new Event('pageshow'));
		});
		await page.waitForTimeout(1_500);
		const calls = await apiLog.since(mark, undefined, { origin: 'browser' });
		expect(calls.filter((c) => STOCK_PATTERNS.productStock.test(c.path) || STOCK_PATTERNS.shopCatalog.test(c.path) || STOCK_PATTERNS.cartRead.test(c.path)), `${path}: no stock request may follow these events`).toEqual([]);
	}
});

// ── 13. PDP trigger (base) ────────────────────────────────────────────────────────────────────────────────────────
test('13. base PDP: the live stock request is issued by the browser on its own (idle trigger), never by a user action', async ({ apiProxyPage: page, api }) => {
	const p = await createStockProduct(api, 'trigger', 5);
	const mark = apiLog.mark();
	await page.goto(brand.pdpPath(p.slug));
	// No click, no scroll, no keypress: the request must still arrive (qidle).
	await expect.poll(async () => (await stockCalls(mark)).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
	expect(brand.pdpTrigger).toBe('qidle'); // the brand's declared trigger; other brands: A8 / owner decision O3
});
