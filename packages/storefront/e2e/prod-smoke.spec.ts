import { expect, request, test, type APIRequestContext, type APIResponse } from '@playwright/test';

/**
 * A10 — production smoke, GET only. Run by the operator after a real build against the live server:
 *
 *   SMOKE_TARGET_URL=http://127.0.0.1:4340 SMOKE_HOST=rottenhand.com SMOKE_PDP_PATH=/shop/<slug>/ \
 *     pnpm exec playwright test -c e2e/prod-smoke.config.ts
 *
 * Environment:
 *   SMOKE_TARGET_URL   required. Without it every check is skipped, and a skip is MISSING COVERAGE, not a pass: each skipped
 *                      test carries a `missing-coverage` annotation and the reason shows in the report.
 *   SMOKE_HOST         optional Host header (the loopback port serves the brand whose Host it is sent).
 *   SMOKE_PDP_PATH     optional product page path (`/products/<slug>/` or `/shop/<slug>/`; a missing trailing slash is added). A brand without a PDP, or an operator
 *                      who did not set it, gets a reported skip.
 *   SMOKE_PRIVATE_PATH optional private order page path, default `/checkout/confirmation/smoke-probe/` (a code that is not an
 *                      order; the page must still be served `private, no-store`).
 *   SMOKE_EXPECT_STOCK_PRIVATE=1  also assert the stock-bearing documents (home, shop, PDP) are `private, no-cache` with no
 *                      CDN cache header (plan A9a). Off by default: it is a statement about the build under test.
 *
 * Page routes are slash-terminated: the Qwik router keeps its default trailing-slash behaviour (vite.config.ts sets no
 * `trailingSlash: false`), so `/shop` answers 301 to `/shop/`. Redirects stay disabled here, so every page is requested at its
 * canonical slash-terminated path and a 301 on a canonical path is a failure. File endpoints (sitemap.xml, robots.txt) have none.
 *
 * What it never does: no POST/PUT/PATCH/DELETE, no cart, no account, no form, no browser. Every request goes through `get()`,
 * which refuses any path that is not on the explicit ALLOWLIST below. Cookies the server sets stay in this run's own request
 * context and are discarded with it.
 *
 * NEVER RUN when this file was written.
 */

const TARGET = (process.env.SMOKE_TARGET_URL ?? '').trim();
const HOST = (process.env.SMOKE_HOST ?? '').trim();
/** Page routes are canonical with a trailing slash; the operator may omit it. Anything with a query, fragment or file extension is left to the allowlist. */
export const canonicalPage = (p: string): string => (p === '' || p.endsWith('/') || /[?#]/.test(p) || /\.[a-z0-9]+$/i.test(p) ? p : `${p}/`);

const PDP_PATH = canonicalPage((process.env.SMOKE_PDP_PATH ?? '').trim());
const PRIVATE_PATH = canonicalPage((process.env.SMOKE_PRIVATE_PATH ?? '/checkout/confirmation/smoke-probe').trim());
const STRICT_STOCK = process.env.SMOKE_EXPECT_STOCK_PRIVATE === '1';
const MISSING = 'missing coverage: SMOKE_TARGET_URL is not set, so this check did not run';

/** The only paths a request may name. No query string, no fragment, no `..`. */
export const ALLOWLIST: readonly RegExp[] = [
	/^\/$/,
	/^\/shop\/$/,
	/^\/sign-in\/$/,
	/^\/track-order\/$/,
	/^\/sitemap\.xml$/,
	/^\/robots\.txt$/,
	/^\/(products|shop)\/[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\/$/,
	/^\/checkout\/confirmation\/[A-Za-z0-9_-]{1,64}\/$/,
];

export const isAllowed = (p: string): boolean => p.startsWith('/') && !/[?#]|\.\./.test(p) && ALLOWLIST.some((re) => re.test(p));

let api: APIRequestContext | undefined;

test.beforeAll(async () => {
	if (!TARGET) return;
	const url = new URL(TARGET);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`SMOKE_TARGET_URL must be http or https, got ${url.protocol}`);
	api = await request.newContext({
		baseURL: url.origin,
		ignoreHTTPSErrors: true,
		extraHTTPHeaders: { ...(HOST ? { Host: HOST } : {}), 'User-Agent': 'sellright-prod-smoke/1', Accept: 'text/html,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5' },
	});
});

test.afterAll(async () => {
	await api?.dispose();
});

function requireTarget(): void {
	if (!TARGET) {
		test.info().annotations.push({ type: 'missing-coverage', description: MISSING });
		test.skip(true, MISSING);
	}
}

async function get(p: string): Promise<APIResponse> {
	if (!isAllowed(p)) throw new Error(`prod-smoke: ${p} is not on the allowlist`);
	if (!api) throw new Error('prod-smoke: no request context (SMOKE_TARGET_URL unset)');
	return api.get(p, { maxRedirects: 0, failOnStatusCode: false, timeout: 20_000 });
}

const header = (res: APIResponse, name: string): string => res.headers()[name] ?? '';

async function expectHtml(res: APIResponse, what: string): Promise<void> {
	expect(res.status(), `${what}: status`).toBe(200);
	expect(header(res, 'content-type'), `${what}: content-type`).toContain('text/html');
	const body = await res.text();
	expect(body, `${what}: a document`).toMatch(/<html[\s>]/i);
	expect(body, `${what}: a title`).toContain('<title');
}

function expectStockPrivate(res: APIResponse, what: string): void {
	if (!STRICT_STOCK) return;
	const cc = header(res, 'cache-control');
	expect(cc, `${what}: cache-control`).toMatch(/private/);
	expect(cc, `${what}: cache-control`).toMatch(/no-cache/);
	expect(cc, `${what}: no shared lifetime`).not.toMatch(/s-maxage/);
	expect(header(res, 'cloudflare-cdn-cache-control'), `${what}: no CDN cache header`).toBe('');
}

test('allowlist: only the named GET paths pass, nothing with a query, fragment or traversal', () => {
	for (const ok of ['/', '/shop/', '/shop/some-product/', '/products/a-b/c/', '/sign-in/', '/track-order/', '/sitemap.xml', '/robots.txt', '/checkout/confirmation/smoke-probe/']) expect(isAllowed(ok), ok).toBe(true);
	for (const bad of ['/cart', '/checkout', '/account', '/sign-in/?x=1', '/shop/../admin/', '/v1/shop/cart/', '/api/anything/', '/newsletter-signup/', '/shop', '/sign-in', '/track-order', '/shop/some-product', '/checkout/confirmation/smoke-probe', '//evil.example', 'https://evil.example/']) expect(isAllowed(bad), bad).toBe(false);
});

test('canonical paths: operator-supplied page paths gain the trailing slash, the private default is slash-terminated and allowed, redirects stay off', () => {
	expect(canonicalPage('/shop/some-product')).toBe('/shop/some-product/');
	expect(canonicalPage('/products/a-b/')).toBe('/products/a-b/');
	expect(canonicalPage('')).toBe('');
	expect(canonicalPage('/sitemap.xml')).toBe('/sitemap.xml');
	expect(PRIVATE_PATH).toMatch(/\/$/);
	if (!process.env.SMOKE_PRIVATE_PATH) expect(PRIVATE_PATH).toBe('/checkout/confirmation/smoke-probe/');
	expect(isAllowed(canonicalPage('/checkout/confirmation/smoke-probe'))).toBe(true);
	expect(isAllowed(canonicalPage('/shop/some-product'))).toBe(true);
});

test('home renders', async () => {
	requireTarget();
	const res = await get('/');
	await expectHtml(res, 'GET /');
	expectStockPrivate(res, 'GET /');
});

test('shop renders', async () => {
	requireTarget();
	const res = await get('/shop/');
	await expectHtml(res, 'GET /shop/');
	expectStockPrivate(res, 'GET /shop/');
});

test('a product page renders', async () => {
	requireTarget();
	if (!PDP_PATH) {
		const why = 'missing coverage: SMOKE_PDP_PATH is not set (no product page was named for this brand)';
		test.info().annotations.push({ type: 'missing-coverage', description: why });
		test.skip(true, why);
	}
	const res = await get(PDP_PATH);
	await expectHtml(res, `GET ${PDP_PATH}`);
	expectStockPrivate(res, `GET ${PDP_PATH}`);
});

test('sign-in renders', async () => {
	requireTarget();
	await expectHtml(await get('/sign-in/'), 'GET /sign-in/');
});

test('track-order renders', async () => {
	requireTarget();
	await expectHtml(await get('/track-order/'), 'GET /track-order/');
});

test('sitemap is served as XML', async () => {
	requireTarget();
	const res = await get('/sitemap.xml');
	expect(res.status(), 'GET /sitemap.xml: status').toBe(200);
	expect(header(res, 'content-type'), 'GET /sitemap.xml: content-type').toMatch(/xml/);
	expect(await res.text(), 'GET /sitemap.xml: body').toMatch(/<(urlset|sitemapindex)[\s>]/);
});

test('robots.txt is served as text', async () => {
	requireTarget();
	const res = await get('/robots.txt');
	expect(res.status(), 'GET /robots.txt: status').toBe(200);
	expect(header(res, 'content-type'), 'GET /robots.txt: content-type').toMatch(/text\/plain/);
	expect(await res.text(), 'GET /robots.txt: body').toMatch(/user-agent/i);
});

test('a private order page is never shared-cacheable', async () => {
	requireTarget();
	const res = await get(PRIVATE_PATH);
	expect([200, 302, 303, 307, 308, 404], `GET ${PRIVATE_PATH}: status ${res.status()}`).toContain(res.status());
	const cc = header(res, 'cache-control');
	expect(cc, `GET ${PRIVATE_PATH}: cache-control`).toMatch(/no-store/);
	expect(cc, `GET ${PRIVATE_PATH}: cache-control`).toMatch(/private/);
	expect(cc, `GET ${PRIVATE_PATH}: no shared lifetime`).not.toMatch(/s-maxage/);
	expect(header(res, 'cloudflare-cdn-cache-control'), `GET ${PRIVATE_PATH}: no CDN cache header`).toBe('');
});
