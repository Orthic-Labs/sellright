import { test as base, expect, type Page } from '@playwright/test';
import { API_URL, EXTERNAL_API, STORE_URL } from './support/env.mjs';
import { AdminApi, clientIp } from './support/api';

/**
 * Every browser-side /v1/* call the storefront makes is same-origin by
 * design (src/sellright/client.ts's sellright() uses baseUrl: '' in the
 * browser) — so in a real deploy nginx/the runtime image co-locates the
 * storefront and API on one origin. For these tests, intercept each same-
 * origin /v1/* request and replay it against the real API instead, forwarding
 * cookies both directions so the cart/session cookies the API sets persist
 * across calls exactly like a co-located deploy would see them.
 *
 * Each page also gets its own simulated client address (`x-real-ip`, the header the API trusts), so the API's per-IP
 * checkout / payment rate limit stays ON while one suite places many orders — and so two shoppers in one spec are
 * two clients.
 */
async function installApiProxy(page: Page): Promise<void> {
	const ip = clientIp();
	const origin = new URL(STORE_URL).origin;
	await page.route((url) => url.origin === origin && url.pathname.startsWith('/v1/'), async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const target = API_URL + url.pathname + url.search;
		const headers: Record<string, string> = { ...req.headers(), 'x-real-ip': ip };
		delete headers['host'];
		delete headers['content-length'];
		try {
			const res = await fetch(target, {
				method: req.method(),
				headers,
				body: ['GET', 'HEAD'].includes(req.method()) ? undefined : ((req.postDataBuffer() ?? undefined) as unknown as BodyInit | undefined),
				redirect: 'manual',
			});
			const body = Buffer.from(await res.arrayBuffer());
			const resHeaders: Record<string, string> = {};
			res.headers.forEach((value, key) => {
				if (key.toLowerCase() === 'content-encoding') return; // undici already decoded the body
				if (key.toLowerCase() === 'set-cookie') return; // handled below: forEach cannot carry more than one
				resHeaders[key] = value;
			});
			// An API answer can set several cookies (session + csrf); a plain header map keeps only the last one, which
			// silently dropped the HttpOnly session cookie. Playwright takes multiple Set-Cookie values newline-joined.
			const cookies = res.headers.getSetCookie();
			if (cookies.length) resHeaders['set-cookie'] = cookies.join('\n');
			await route.fulfill({ status: res.status, headers: resHeaders, body });
		} catch (error) {
			await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PROXY_FAILED', message: String(error) } }) });
		}
	});
}

/**
 * Nothing in a browser test may leave this machine: NMI's Collect.js, Sezzle's hosted checkout, Stripe.js, fonts and
 * analytics all resolve to an aborted request unless a spec fulfils them explicitly (registered later = matched first).
 */
async function blockExternal(page: Page): Promise<void> {
	await page.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol.startsWith('http'), (route) => route.abort('blockedbyclient'));
}

/** Stand-in for NMI's hosted Collect.js: same public surface the storefront uses (configure / startPaymentRequest),
 *  returning the card token the spec chose (`window.__E2E_CARD_TOKEN`, default an approvable one). No card data exists. */
const COLLECT_JS = `
window.CollectJS = {
	_cfg: null,
	configure(cfg) { this._cfg = cfg; setTimeout(() => cfg.fieldsAvailableCallback && cfg.fieldsAvailableCallback(), 0); },
	startPaymentRequest() { const cfg = this._cfg; setTimeout(() => cfg.callback({ token: window.__E2E_CARD_TOKEN || 'tok_visa' }), 0); },
};`;

async function stubCollectJs(page: Page): Promise<void> {
	await page.route('https://sandbox.nmi.com/token/Collect.js', (route) =>
		route.fulfill({ status: 200, contentType: 'application/javascript', body: COLLECT_JS }));
}

/** The card token the next NMI "Pay" produces: `tok_visa` approves, `tok_decline` is declined by the mock gateway. */
export const setCardToken = (page: Page, token: string) => page.evaluate((t) => { (window as unknown as { __E2E_CARD_TOKEN?: string }).__E2E_CARD_TOKEN = t; }, token);

/** Give any page (e.g. a second shopper's browser context) the same wiring `apiProxyPage` has. */
export async function prepareShopperPage(page: Page): Promise<Page> {
	await blockExternal(page);
	await stubCollectJs(page);
	await installApiProxy(page);
	return page;
}

export const test = base.extend<{ apiProxyPage: Page }, { api: AdminApi }>({
	/** Signed-in owner API client (bearer, worker-scoped) for arranging state and reading the live truth back. */
	// eslint-disable-next-line no-empty-pattern
	api: [async ({}, use) => { await use(EXTERNAL_API ? (undefined as never) : await AdminApi.login()); }, { scope: 'worker' }],
	apiProxyPage: async ({ page }, use) => {
		await use(await prepareShopperPage(page));
	},
});

/** Money-path specs place real orders against a database + mock gateways the harness owns. */
export const skipExternal = () => test.skip(EXTERNAL_API, 'money-path specs need the fresh API + mock gateways (unset PLAYWRIGHT_API_URL)');

export { expect };
