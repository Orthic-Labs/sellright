import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { CATALOG_DIR, FS_LOG_FILE, SHOP_API_URL, STORE_URL } from './support/env.mjs';
import { clientIp } from './support/api';
import { apiLog, STOCK_PATTERNS } from './support/api-log';
import { addToCart, fillShipping, goToCheckout, placeOrderButton } from './support/flows';
import { createStockProduct, currentGeneration, setOnHand, waitForNewGeneration, waitForPublishedProduct } from './support/stock';
import { brand } from './support/parity-brands';
import { readFileSync, renameSync, existsSync, rmSync, writeFileSync } from 'node:fs';
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
 * Implemented here: 1 (same-document + reload), 2, 3a/3b/3c, 4, 5, 6, 8, 10c, 11 (dynamic), 12, 13 (base), 15, 17 (dynamic). Static scenarios 9 (publisher
 * source), 10a/b/d, 12 (static), 14, 17 (structural) live in unit suites that run with `pnpm test`:
 *   packages/api/src/manifest/{stock-hook,no-search-index}.test.ts, packages/storefront/src/services/stock-guards.test.ts.
 * NOT implemented (blocked): 7 (needs an option-group product seed), 16 and 18 (owner decision O1, Rotten product route).
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
	// The shop document is built from the published manifest (layer 1), and the toggle's live read only overrides
	// products the manifest lists: wait for the publication that carries the new product before loading the shop.
	await waitForPublishedProduct(p.slug, true);
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
	// The open drawer is a full-screen overlay (fixed inset-0) that covers the header cart button, so a shopper closes it
	// through its own "Close cart" backdrop; clicking the header button while it is open never reaches the button.
	const closeCart = async (page: Page) => {
		await page.getByRole('button', { name: /^close cart$/i }).click();
		await expect(page.getByRole('dialog', { name: /shopping cart/i })).toHaveCount(0);
	};

	test('3a cart open: every open issues its own live read and shows the change; sequential opens never coalesce', async ({ apiProxyPage: page, api }) => {
		const p = await createStockProduct(api, 'cart', 5);
		await addToCart(page, p.slug); // the drawer is open after adding

		await closeCart(page);
		let mark = apiLog.mark();
		await cartButton(page).click(); // open #1
		await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.cartRead, { origin: 'browser' })).length).toBeGreaterThanOrEqual(1);

		await closeCart(page);
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

	// A guard that refreshes only on the FIRST checkout entry per document (module-level flag, in-memory cache) passes 3b,
	// whose second entry is a full load (new document, fresh module state). This entry is a second SPA entry in the SAME
	// document. The drawer is opened and settled first, so its own cart-open read is outside the isolated window and the
	// only read that can satisfy the assertion after the mark is the checkout-entry read.
	// UNVERIFIED: header link / cart button on the checkout page follow 3a and spaToShop; adjust on first run.
	test('3b-ii checkout entry twice in the SAME document: the second SPA entry issues its own live cart read and shows the change', async ({ apiProxyPage: page, api }) => {
		const p = await createStockProduct(api, 'entry2', 5);
		await addToCart(page, p.slug);
		await goToCheckout(page); // entry 1
		await markDocument(page, 'doc-entry');
		// Place Order is aria-disabled here (shipping/customer fields are empty), so it says nothing about stock. The proof is
		// the line itself: this product's own row in the order summary is present and not marked out of stock now ...
		// the cart line is an <li> carrying the product name ("Parity <tag>", unique per test); the name link is not always rendered
		const line = page.locator('li').filter({ hasText: `Parity ${p.slug.replace(/^par-/, '')}` });
		await expect(line, 'entry 1: the product line is in the order summary').toHaveCount(1);
		await expect(line.getByText(/out of stock/i), 'entry 1: the line is available').toHaveCount(0);

		await spaToShop(page); // leave checkout without a document load
		await cartButton(page).click();
		await expect(page.getByRole('dialog', { name: /shopping cart/i })).toBeVisible();
		await page.waitForLoadState('networkidle');
		await setOnHand(api, p.sku, 0); // the drawer still shows the unit; only a live read can see it gone
		const mark = apiLog.mark();
		await page.getByRole('button', { name: /^checkout$/i }).click(); // entry 2: SPA navigation
		await page.waitForURL('**/checkout/**');
		await page.waitForLoadState('networkidle');

		expect(await sameDocument(page), 'entry 2 must be an SPA navigation in the same document (no reload)').toBe('doc-entry');
		await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.cartRead, { origin: 'browser' })).length, { message: 'second entry in the same document must issue a NEW live cart read after the mark' }).toBeGreaterThanOrEqual(1);
		// ... and after the second entry it is gone or shows its own "Out of stock": only a fresh live read can cause either.
		await expect.poll(async () => (await line.count()) === 0 || (await line.getByText(/out of stock/i).count()) > 0, { message: `the line for ${p.sku} must be removed or marked out of stock after the second entry` }).toBe(true);
		expect(await sameDocument(page), 'still the same document after the read').toBe('doc-entry');
	});

	test('3c-i submit with stock gone is refused by the pre-submit live read: no order POST, the UI says so', async ({ apiProxyPage: page, api }) => {
		const p = await createStockProduct(api, 'submit', 1);
		await addToCart(page, p.slug);
		await goToCheckout(page);
		await fillShipping(page, `${p.slug}@e2e.example.net`);
		await setOnHand(api, p.sku, 0); // the last unit sold elsewhere after the shopper reached PLACE ORDER
		const mark = apiLog.mark();
		await placeOrderButton(page).click();
		await expect.poll(async () => (await apiLog.since(mark, STOCK_PATTERNS.cartRead, { method: 'GET', origin: 'browser' })).length, { message: 'PLACE ORDER must start with a live cart read' }).toBeGreaterThanOrEqual(1);
		await expect(page.locator('body')).toContainText(droppedNotice);
		await expect(page).not.toHaveURL(/confirmation/);
		expect(await apiLog.since(mark, STOCK_PATTERNS.checkout, { method: 'POST' }), 'the pre-submit read found the line unavailable: no order may be created').toEqual([]);
	});

	// Server backstop: the stock vanishes AFTER the pre-submit read answered (held open and zeroed in the route), so the
	// order POST is sent and the server's 409 OUT_OF_STOCK still refuses the sale.
	// The held read is fetched from the API itself (the page's /v1 calls are proxied there by apiProxyPage; a plain
	// route.fetch() would ask the storefront origin and get a 404, which the pre-submit check rightly refuses).
	test('3c-ii stock sold between the pre-submit read and the order POST: the server refuses with 409, no order, the UI says so', async ({ apiProxyPage: page, api }) => {
		const p = await createStockProduct(api, 'race', 1);
		await addToCart(page, p.slug);
		await goToCheckout(page);
		await fillShipping(page, `${p.slug}@e2e.example.net`);
		await page.waitForLoadState('networkidle');
		let armed = true;
		await page.route((url) => STOCK_PATTERNS.cartRead.test(url.pathname), async (route) => {
			if (!armed || route.request().method() !== 'GET') return route.fallback();
			armed = false;
			const asked = new URL(route.request().url());
			const live = await route.fetch({ url: SHOP_API_URL + asked.pathname + asked.search, headers: { ...route.request().headers(), 'x-real-ip': clientIp(), 'x-e2e-origin': 'browser' } }); // the pre-submit read sees the unit in stock ...
			await setOnHand(api, p.sku, 0); // ... and it sells right after
			await route.fulfill({ response: live });
		});
		const response = page.waitForResponse((r) => r.url().includes('/v1/shop/checkout') && r.request().method() === 'POST');
		await placeOrderButton(page).click();
		expect((await response).status(), 'POST /v1/shop/checkout must refuse an out-of-stock line').toBe(409);
		await expect(page.locator('body')).toContainText(droppedNotice);
		await expect(page).not.toHaveURL(/confirmation/);
	});

	test('3c-iii a live cart read is issued BEFORE the order-creating POST (locked rule, layer 4)', async ({ apiProxyPage: page, api }) => {
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

// ── 11 + 17. shop document reads through one server process (reader contract, plan A4; owner decision O2 = no age expiry) ─
const FS_TAP = process.env.E2E_FS_TAP === '1';
/** marker.json and shop-catalog*.json reads the storefront server made since `mark` (fs tap; empty when the tap is off). */
function fsReadsSince(mark: number): { marker: number; catalog: number } {
	if (!FS_TAP) return { marker: 0, catalog: 0 };
	let raw = '';
	try { raw = readFileSync(FS_LOG_FILE, 'utf8'); } catch { /* no log yet */ }
	const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { time: number; path: string }).filter((r) => r.time >= mark);
	return { marker: rows.filter((r) => /marker\.json$/.test(r.path)).length, catalog: rows.filter((r) => /shop-catalog[^/]*\.json$/.test(r.path)).length };
}
const shopListingCalls = (mark: number) => apiLog.since(mark, STOCK_PATTERNS.shopCatalog);
const shopCard = (page: Page, slug: string) => page.locator(`a[href*="${slug}"]`);

test.describe('17. shop document reloads through one server process, publications in between', () => {
	test.skip(!CATALOG_DIR, 'needs E2E_CATALOG_DIR (the real publisher): did not run, missing coverage');

	test('17 every document load reads marker.json and shop-catalog.json from disk, follows each publication, and never calls the live listing while a fresh generation exists', async ({ page, api }) => {
		const a = await createStockProduct(api, 'shopa', 5);
		const b = await createStockProduct(api, 'shopb', 5);
		let generation = currentGeneration()?.name ?? null;
		const steps = [
			{ sku: a.sku, onHand: 0, expect: [[a.slug, false], [b.slug, true]] },
			{ sku: a.sku, onHand: 4, expect: [[a.slug, true], [b.slug, true]] },
			{ sku: b.sku, onHand: 0, expect: [[a.slug, true], [b.slug, false]] },
			{ sku: b.sku, onHand: 3, expect: [[a.slug, true], [b.slug, true]] },
		] as const;
		let sawFsRead = false;
		for (const [i, step] of steps.entries()) {
			await setOnHand(api, step.sku, step.onHand);
			generation = (await waitForNewGeneration(generation)).name;
			// let the burst settle: the last publication must carry the final state before the document is read
			await new Promise((r) => setTimeout(r, 1_000));
			generation = currentGeneration()!.name;
			for (const load of ['after the publication', 'again with no publication in between'] as const) {
				const mark = Date.now();
				await page.goto(brand.shopPath);
				await page.waitForLoadState('networkidle');
				for (const [slug, visible] of step.expect) {
					await expect(shopCard(page, slug), `step ${i + 1} ${load}: ${slug} must ${visible ? 'be listed' : 'be hidden by "in stock only"'}`).toHaveCount(visible ? 1 : 0);
				}
				expect(await shopListingCalls(mark), `step ${i + 1} ${load}: a fresh generation exists, so the reader must serve the shop (no live listing call)`).toEqual([]);
				if (FS_TAP) {
					const reads = fsReadsSince(mark);
					sawFsRead ||= reads.marker + reads.catalog > 0;
					if (sawFsRead) {
						expect(reads.marker, `step ${i + 1} ${load}: the document request must re-read marker.json`).toBeGreaterThanOrEqual(1);
						expect(reads.catalog, `step ${i + 1} ${load}: the document request must re-read shop-catalog.json (no reader memo / generation-keyed cache)`).toBeGreaterThanOrEqual(1);
					}
				}
			}
		}
		if (FS_TAP) expect(sawFsRead, 'the fs tap recorded no read at all: it did not reach the server (plan A9 scenario 17 gap) — report, do not pass silently').toBe(true);
		else test.info().annotations.push({ type: 'fs-tap', description: 'E2E_FS_TAP=1 not set: the per-load disk-read assertion did not run' });
	});
});

test.describe.serial('11. a snapshot that is invalid or absent falls back to the live API; a valid old one does not', () => {
	test.skip(!CATALOG_DIR, 'needs E2E_CATALOG_DIR (the real publisher): did not run, missing coverage');

	/** Run `body` with the current generation's marker replaced; always restore it. */
	async function withMarker(mutate: (marker: Record<string, unknown>) => Record<string, unknown>, body: () => Promise<void>) {
		const gen = currentGeneration()!;
		const file = join(gen.dir, 'marker.json');
		const original = readFileSync(file, 'utf8');
		writeFileSync(file, JSON.stringify(mutate(JSON.parse(original))));
		try { await body(); } finally { writeFileSync(file, original); }
	}
	/** Wait until the published manifest shows `slug` with `inStock`, so no publication is still in flight when a marker is edited. */
	async function waitForManifest(slug: string, inStock: boolean) {
		await expect.poll(() => {
			const gen = currentGeneration();
			if (!gen) return undefined;
			const catalog = JSON.parse(readFileSync(join(gen.dir, 'shop-catalog.json'), 'utf8')) as { products: Array<{ slug: string; inStock?: boolean }> };
			return catalog.products.find((x) => x.slug === slug)?.inStock;
		}, { timeout: 30_000, message: `manifest must show ${slug} inStock=${inStock}` }).toBe(inStock);
		await new Promise((r) => setTimeout(r, 1_000)); // no trailing generation may land mid-test
	}
	async function loadShop(page: Page) {
		const mark = Date.now();
		await page.goto(brand.shopPath);
		await page.waitForLoadState('networkidle');
		return { mark, calls: await shopListingCalls(mark) };
	}

	test('11a a valid generation hours old is still served from disk (no age-based expiry)', async ({ page, api }) => {
		const p = await createStockProduct(api, 'old', 5);
		await waitForManifest(p.slug, true);
		await withMarker((m) => ({ ...m, generatedAt: new Date(Date.now() - 6 * 3_600_000).toISOString() }), async () => {
			const { calls } = await loadShop(page);
			expect(calls, 'an old but intact generation must not trigger the live listing').toEqual([]);
			await expect(shopCard(page, p.slug)).toHaveCount(1);
		});
	});

	test('11b a foreign tenant marker is rejected: live listing is used and stock stays live', async ({ page, api }) => {
		const p = await createStockProduct(api, 'foreign', 5);
		await setOnHand(api, p.sku, 0);
		await waitForManifest(p.slug, false);
		await withMarker((m) => ({ ...m, storeSlug: 'another-tenant' }), async () => {
			const { calls } = await loadShop(page);
			expect(calls.filter((c) => c.origin === 'server').length, 'the rejected snapshot must fall back to the live API').toBeGreaterThanOrEqual(1);
			await expect(shopCard(page, p.slug), 'live listing: the sold-out product is hidden by "in stock only"').toHaveCount(0);
		});
	});

	test('11c an unsupported marker format or a bad generation name is rejected the same way', async ({ page, api }) => {
		const p = await createStockProduct(api, 'badmark', 5);
		await waitForManifest(p.slug, true);
		for (const mutate of [(m: Record<string, unknown>) => ({ ...m, format: 3 }), (m: Record<string, unknown>) => ({ ...m, generation: '00000000-0000-0000-0000-000000000000' })]) {
			await withMarker(mutate, async () => {
				const { calls } = await loadShop(page);
				expect(calls.filter((c) => c.origin === 'server').length).toBeGreaterThanOrEqual(1);
				await expect(shopCard(page, p.slug)).toHaveCount(1); // live stock says 5
			});
		}
	});

	test('11d a missing current pointer falls back to the live API; the shop never serves an empty or fail-open list', async ({ page, api }) => {
		const p = await createStockProduct(api, 'nocurrent', 5);
		await waitForManifest(p.slug, true);
		const current = join(CATALOG_DIR!, 'current');
		const parked = join(CATALOG_DIR!, 'current.parked');
		renameSync(current, parked);
		try {
			const { calls } = await loadShop(page);
			expect(calls.filter((c) => c.origin === 'server').length).toBeGreaterThanOrEqual(1);
			await expect(shopCard(page, p.slug)).toHaveCount(1);
		} finally {
			if (existsSync(current)) rmSync(parked, { force: true }); else renameSync(parked, current);
		}
	});
});

// ── 15. document cache headers: every document is private, no-store ─────────────────────────────────────────────
test('15 every document is private no-store with no CDN cache header, including non-stock pages and unknown paths', async ({ api, request }) => {
	const p = await createStockProduct(api, 'headers', 5);
	for (const path of ['/', brand.shopPath, brand.pdpPath(p.slug), '/search/', '/contact/', '/definitely-not-a-route/']) {
		const res = await request.get(path);
		const h = res.headers();
		expect(h['cache-control'], `${path}: private no-store`).toMatch(/private/);
		expect(h['cache-control'], `${path}: private no-store`).toMatch(/no-store/);
		expect(h['cache-control'], `${path}: no shared lifetime`).not.toMatch(/s-maxage|max-age=[1-9]/);
		expect(h['cloudflare-cdn-cache-control'], `${path}: no CDN cache header`).toBeUndefined();
		expect(h['cdn-cache-control'], `${path}: no CDN cache header`).toBeUndefined();
		if (res.status() < 400) expect(h['x-cache-policy-version'], path).toBeTruthy();
	}
	const stock = await request.get('/');
	expect(stock.headers()['x-route-class']).toBe('stock_bearing');
});
