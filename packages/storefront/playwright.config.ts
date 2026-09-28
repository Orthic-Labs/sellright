import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the storefront's own production build (not vite dev — the
 * same `node server/entry.express.js` a real deploy runs). Every browser
 * `/v1/*` call is same-origin by design (see src/sellright/client.ts); tests
 * intercept those requests (see e2e/fixtures.ts's `apiProxyPage`) and forward
 * them to the real SellRight API (`PLAYWRIGHT_API_URL`, default
 * http://127.0.0.1:3300) — no separate reverse proxy process needed, in CI
 * or locally.
 *
 * `webServer` starts the storefront itself if PLAYWRIGHT_BASE_URL isn't
 * already pointing at a running instance — `reuseExistingServer` lets a
 * developer keep an already-running `pnpm run build && node server/...`
 * server up across test runs.
 */
const PORT = process.env.PLAYWRIGHT_PORT ?? '4398';
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
	testDir: './e2e',
	fullyParallel: false, // one dev API instance backs every test — avoid cart/order collisions
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: process.env.CI ? [['github'], ['list']] : [['list']],
	timeout: 30_000,
	use: {
		baseURL: BASE_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
	],
	webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
		? undefined
		: {
				command: `node server/entry.express.js`,
				url: BASE_URL,
				reuseExistingServer: !process.env.CI,
				timeout: 60_000,
				env: {
					PORT,
					HOST: '127.0.0.1',
					NODE_ENV: 'production',
					SELLRIGHT_API_URL: process.env.PLAYWRIGHT_API_URL ?? 'http://127.0.0.1:3300',
				},
			},
});
