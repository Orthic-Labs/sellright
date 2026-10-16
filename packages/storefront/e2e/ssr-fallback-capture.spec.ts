import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, skipExternal, prepareShopperPage } from './fixtures';
import { ApiFailure, SKU, paidOrder, readRows } from './support/api';
import { PASSWORD, registerAndVerify, signInWithPassword } from './support/account';
import { addToCart, goToCheckout } from './support/flows';
import { readFileSync } from 'node:fs';
const inventory = JSON.parse(readFileSync(new URL('./support/ssr-pages.json', import.meta.url), 'utf8'));

/**
 * Brand views, plan §2.7 "Fallback proof". With no view files, head.json or routes.json every mount takes today's branch, so the SSR
 * output must be the same before and after the change. The pages, their expected status and marker live in e2e/support/ssr-pages.json
 * (the same inventory scripts/ssr-normalize.mjs compares against, so a matching pair of error pages or an empty directory cannot pass).
 *
 * Run once on main and once on the branch, each against a fresh harness and its own output directory, then compare:
 *   E2E_FALLBACK_OUT=<dir-before> pnpm test:e2e:run e2e/ssr-fallback-capture.spec.ts   (main build)
 *   E2E_FALLBACK_OUT=<dir-after>  pnpm test:e2e:run e2e/ssr-fallback-capture.spec.ts   (branch build)
 *   node scripts/ssr-normalize.mjs <dir-before> <dir-after>
 * Pages whose inventory entry says `"kind": "rendered"` need a shopper (a populated cart, a signed-in checkout with loyalty points, the
 * order history, the address book): their data loads in the browser, so the capture is the settled DOM of the surface after it
 * loaded, with scripts and styles removed. The harness data is created the same way on both builds (one fixed shopper, one fixed address,
 * one paid order, loyalty on) and the only per-run values (order code, ids, dates) are replaced by fixed tokens before writing.
 * No order is placed from the checkout. Without E2E_FALLBACK_OUT every capture test is skipped; a capture test that does not write its file fails.
 */
skipExternal();
const OUT = process.env.E2E_FALLBACK_OUT ?? '';
const POST = { slug: 'ssr-capture-post', title: 'SSR capture post', publishDate: '2025-01-15T12:00:00.000Z' };
const INDEXNOW_KEY = 'e2e0123456789abcdef0123456789abcdef';
const SHOPPER = { email: 'ssr-capture-shopper@example.net', first: 'Sam', last: 'Capture' };
const ADDRESS = { name: 'Sam Capture', street: '1 Capture Way', city: 'Reno', state: 'NV', zip: '89501' };
const LOYALTY = {
	enabled: true, earnRatePerDollar: 2, pointsPerDollarOff: 10, minRedeemPoints: 0, maxRedeemPercentOfSubtotal: null, expiryDays: null,
	reviewBonusPoints: 0, reviewBonusVerifiedOnly: true, signupBonusPoints: 0, signupBonusSince: null, firstOrderBonusPoints: 0, birthdayBonusPoints: 0, productMultipliers: [],
};
let orderCode = '';

/** The settled DOM of `selector` (default the whole body) without scripts, styles or per-run values: order code, ids and dates. */
async function renderedMarkup(page: Page, selector = 'body'): Promise<string> {
	const html = await page.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const copy = el.cloneNode(true) as Element;
		copy.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
		return copy.outerHTML;
	}, selector);
	expect(html, `${selector} exists`).not.toBeNull();
	expect(orderCode, 'the paid order code is known').not.toBe('');
	return html!
		.split(orderCode).join('ORDER-CODE')
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')
		.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}\b/g, 'DATE')
		.replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g, 'TIMESTAMP');
}

/** Writes `<OUT>/<name>.txt` and reads it back: a capture that is not on disk fails the test. */
function writeCapture(name: string, body: string, status = 200, contentType = 'text/html') {
	const file = path.join(OUT, `${name}.txt`);
	fs.mkdirSync(OUT, { recursive: true });
	fs.writeFileSync(file, `status: ${status}\ncontent-type: ${contentType}\n\n${body}`);
	expect(fs.existsSync(file) && fs.statSync(file).size > body.length, `${file} was written`).toBe(true);
}

async function fillAddress(page: Page) {
	await expect(async () => {
		await page.locator('#fullName').fill(ADDRESS.name);
		await page.locator('#streetLine1').fill(ADDRESS.street);
		await page.locator('#postalCode').fill(ADDRESS.zip);
		await page.locator('#city').fill(ADDRESS.city);
		await page.locator('#province').fill(ADDRESS.state);
		await page.keyboard.press('Tab');
		await page.waitForTimeout(500);
		await expect(page.locator('#streetLine1')).toHaveValue(ADDRESS.street, { timeout: 1_000 });
		await expect(page.locator('#city')).toHaveValue(ADDRESS.city, { timeout: 1_000 });
	}).toPass({ timeout: 20_000 });
}

test.describe.serial('SSR capture for the fallback proof', () => {
	test.skip(process.env.E2E_BRAND_VIEWS === '1', 'the fixture build replaces the pages under test: capture on the default build');
	test.skip(!OUT, 'a capture run: set E2E_FALLBACK_OUT to the output directory');

	test.beforeAll(async ({ api, browser }) => {
		// A fixed post (title, slug, date, body) so the page is identical in the two runs; an already existing one is kept.
		try {
			await api.post('/blog', {
				title: POST.title, slug: POST.slug, excerpt: 'A fixed post for the SSR comparison.', publishDate: POST.publishDate,
				body: '<h2>First heading</h2><p>Body paragraph.</p><h3>Second heading</h3><p>More body.</p>',
				authorName: 'E2E Author', tags: ['e2e'], isPublished: true,
			});
		} catch (e) {
			if (!(e instanceof ApiFailure) || ![400, 409].includes(e.status)) throw e;
		}
		await api.patch('/seo/config', { indexNowKey: INDEXNOW_KEY });

		// The signed-in shopper: one fixed account, one saved address, one paid order, loyalty on (so the order earns points).
		await api.put('/loyalty/settings', LOYALTY);
		const context = await browser.newContext();
		try {
			const page = await prepareShopperPage(await context.newPage());
			const known = await readRows(api, 'SELECT 1 FROM customer WHERE email = $1', [SHOPPER.email]);
			if (known.length === 0) await registerAndVerify(page, SHOPPER.email, { first: SHOPPER.first, last: SHOPPER.last });
			else await page.goto('/');
			const book = await readRows(api, 'SELECT a.id FROM address a JOIN customer c ON c.id = a.customer_id WHERE c.email = $1', [SHOPPER.email]);
			if (book.length === 0) {
				await signInWithPassword(page, SHOPPER.email, PASSWORD);
				await page.goto('/account/address-book/add');
				await fillAddress(page);
				await page.getByRole('button', { name: /^\s*save/i }).click();
				await page.waitForURL(/\/account\/address-book\/?$/, { timeout: 20_000 });
			}
		} finally {
			await context.close();
		}
		const orders = await readRows<{ code: string }>(api, `SELECT o.code FROM "order" o JOIN customer c ON c.id = o.customer_id WHERE c.email = $1 ORDER BY o.created_at LIMIT 1`, [SHOPPER.email]);
		orderCode = orders[0]?.code ?? (await paidOrder({ email: SHOPPER.email, items: [{ sku: SKU.mug, quantity: 2 }] })).code;
	});

	test.afterAll(async ({ api }) => {
		await api.patch('/seo/config', { indexNowKey: null }); // leave the store as found
		await api.put('/loyalty/settings', { ...LOYALTY, enabled: false });
	});

	for (const p of inventory.pages.filter((x: { kind?: string }) => x.kind !== 'rendered')) {
		test(`capture ${p.name}`, async ({ request }) => {
			const res = await request.get(p.path);
			const body = await res.text();
			writeCapture(p.name, body, res.status(), res.headers()['content-type'] ?? '');
			expect(res.status(), `${p.path} status`).toBe(p.status);
			if (p.marker) expect(body, `${p.path} marker`).toContain(p.marker);
			if (!p.allowEmptyBody) expect(body.trim(), `${p.path} body`).not.toBe('');
		});
	}

	// ── rendered surfaces (settled DOM) ───────────────────────────────────────────────────────────────────────

	const expectRendered = (name: string, body: string) => {
		const p = inventory.pages.find((x: { name: string }) => x.name === name);
		expect(p, `${name} is in the inventory`).toBeTruthy();
		// A page with a documented expectedDifference records the marker if it is there: main (before) never renders it, and
		// scripts/ssr-normalize.mjs requires it on the branch (after) and compares the rest strictly.
		if (!p.expectedDifference) expect(body, `${name} marker`).toContain(p.marker);
		writeCapture(name, body);
	};

	test('capture cart-drawer (a guest, one line)', async ({ apiProxyPage: page }) => {
		await addToCart(page, 'e2e-shirt'); // leaves the drawer open on the new line
		const drawer = page.locator('[role="dialog"][aria-label="Shopping cart"]');
		await expect(drawer.getByRole('button', { name: /remove item/i })).toHaveCount(1);
		await page.waitForLoadState('networkidle');
		expectRendered('cart-drawer', await renderedMarkup(page, '[role="dialog"][aria-label="Shopping cart"]'));
	});

	test('capture checkout-loyalty (signed in, points to spend; no order is placed)', async ({ apiProxyPage: page }) => {
		await signInWithPassword(page, SHOPPER.email, PASSWORD);
		await addToCart(page, 'e2e-shirt');
		await goToCheckout(page);
		const redeem = page.getByTestId('loyalty-redeem');
		// The control must render on every build that has it (the gateway once broke it: a null prop dropped by a JSX spread threw). Only
		// the capture taken from a build older than brand views PR 1 lacks it, which is what expectedDifference in ssr-pages.json is for.
		await expect(redeem).toBeVisible({ timeout: 15_000 });
		await page.waitForLoadState('networkidle');
		expectRendered('checkout-loyalty', await renderedMarkup(page));
	});

	test('capture account-orders (the paid order in the history)', async ({ apiProxyPage: page }) => {
		await signInWithPassword(page, SHOPPER.email, PASSWORD);
		await page.goto('/account/orders');
		await expect(page.getByRole('link', { name: new RegExp(`Order #${orderCode}`) })).toBeVisible({ timeout: 15_000 });
		await page.waitForLoadState('networkidle');
		expectRendered('account-orders', await renderedMarkup(page));
	});

	test('capture account-address-book (the saved address)', async ({ apiProxyPage: page }) => {
		await signInWithPassword(page, SHOPPER.email, PASSWORD);
		await page.goto('/account/address-book');
		await expect(page.getByText(ADDRESS.street)).toBeVisible({ timeout: 15_000 });
		await page.waitForLoadState('networkidle');
		expectRendered('account-address-book', await renderedMarkup(page));
	});
});
