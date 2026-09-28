import { test as base, expect, type Page } from '@playwright/test';

const API_BASE = process.env.PLAYWRIGHT_API_URL ?? 'http://127.0.0.1:3300';

/**
 * Every browser-side /v1/* call the storefront makes is same-origin by
 * design (src/sellright/client.ts's sellright() uses baseUrl: '' in the
 * browser) — so in a real deploy nginx/the runtime image co-locates the
 * storefront and API on one origin. For these tests, intercept each same-
 * origin /v1/* request and replay it against the real API instead, forwarding
 * cookies both directions so the cart/session cookies the API sets persist
 * across calls exactly like a co-located deploy would see them.
 */
async function installApiProxy(page: Page): Promise<void> {
	await page.route('**/v1/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const target = API_BASE + url.pathname + url.search;
		const headers = { ...req.headers() };
		delete headers['host'];
		delete headers['content-length'];
		try {
			const res = await fetch(target, {
				method: req.method(),
				headers,
				body: ['GET', 'HEAD'].includes(req.method()) ? undefined : (req.postDataBuffer() ?? undefined),
				redirect: 'manual',
			});
			const body = Buffer.from(await res.arrayBuffer());
			const resHeaders: Record<string, string> = {};
			res.headers.forEach((value, key) => {
				if (key.toLowerCase() === 'content-encoding') return; // undici already decoded the body
				resHeaders[key] = value;
			});
			await route.fulfill({ status: res.status, headers: resHeaders, body });
		} catch (error) {
			await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PROXY_FAILED', message: String(error) } }) });
		}
	});
}

export const test = base.extend<{ apiProxyPage: Page }>({
	// eslint-disable-next-line no-empty-pattern
	apiProxyPage: async ({ page }, use) => {
		await installApiProxy(page);
		await use(page);
	},
});

export { expect };
