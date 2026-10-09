import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the storefront's own production build (not vite dev — the
 * same `node server/entry.express.js` a real deploy runs). Every browser
 * `/v1/*` call is same-origin by design (see src/sellright/client.ts); tests
 * intercept those requests (see e2e/fixtures.ts's `apiProxyPage`) and forward
 * them to the real SellRight API — no separate reverse proxy process needed,
 * in CI or locally.
 *
 * Two modes:
 *  - fresh (default): Playwright starts a mock-gateway process (NMI / Sezzle / IndexNow / webhook receiver / SMTP sink), a
 *    throwaway API on :3398 over a freshly created `sellright_storefront_e2e` database (like the admin suite), and the
 *    storefront. Money-path, account (register / sign-in / magic link / address book / returns / rewards / reviews) and
 *    content (blog / sitemap / IndexNow) specs run here: real checkout, real payment code, real outbox workers, mocked
 *    gateways, and a mock of the IndexNow endpoint so no search engine is ever pinged.
 *  - external (PLAYWRIGHT_API_URL set): only the storefront is started and forwarded to that API; the money-path
 *    specs (which need the mock gateways and a database they own) skip themselves.
 *
 * Never points at :3300, sellright_dev, dd_sellright, rh_sellright, sellright_demo or rightsites (assertSafeTargets).
 */
import { API_URL, EXTERNAL_API, MOCK_PORT, STORE_PORT, STORE_URL, assertSafeTargets } from './e2e/support/env.mjs';

assertSafeTargets();

// Dev loop: E2E_REUSE_SERVERS=1 keeps an already-running mock/API/storefront triple (the API database is NOT reset).
const reuse = !!process.env.E2E_REUSE_SERVERS && !process.env.CI;

const storefrontServer = {
	// `pnpm run e2e:build` (part of `pnpm test:e2e`) builds server-e2e/dist-e2e: the production build with SSG off, so
	// every page renders from THIS suite's API instead of a snapshot of whatever store was live at build time.
	command: `node ${process.env.E2E_STORE_SERVER ?? 'server-e2e/entry.express.js'}`,
	url: STORE_URL,
	// The storefront server is stateless, so a developer's already-running build can always be reused.
	reuseExistingServer: !process.env.CI,
	timeout: 60_000,
	name: 'storefront',
	env: {
		PORT: String(STORE_PORT),
		HOST: '127.0.0.1',
		NODE_ENV: 'production',
		SELLRIGHT_API_URL: API_URL,
		// Never inherit the operator's published catalog snapshot (a real store's manifest would shadow this
		// suite's database): with no directory the shop reads the live API, which is what a fresh CI store does.
		CATALOG_DIR: '',
	},
};

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.spec.ts',
	globalSetup: './e2e/support/global-setup.ts',
	fullyParallel: false, // one API + database backs every test — avoid cart/order collisions
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	// 'html' (CI only) so a failure leaves a browsable report + the
	// retain-on-failure traces/screenshots somewhere the workflow can upload —
	// without it, `playwright-report/` never gets created and CI's
	// "Upload Playwright report on failure" step has nothing to attach.
	reporter: process.env.CI ? [['github'], ['html', { open: 'never' }], ['list']] : [['list']],
	timeout: 60_000,
	expect: { timeout: 10_000 },
	use: {
		baseURL: STORE_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
	],
	webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
		? undefined
		: EXTERNAL_API
			? [storefrontServer]
			: [
					{
						// Mock NMI + Sezzle + webhook receiver + SMTP sink: the only "gateways" the API can reach.
						command: 'node e2e/support/mock-gateways.mjs',
						url: `http://127.0.0.1:${MOCK_PORT}/health`,
						reuseExistingServer: reuse,
						timeout: 30_000,
						gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
						stdout: 'pipe',
						stderr: 'pipe',
						name: 'mock-gateways',
					},
					{
						// Fresh API + database per run (drops/recreates sellright_storefront_e2e, migrates, bootstraps, serves).
						command: 'node e2e/support/start-api.mjs',
						url: `${API_URL}/v1/readyz`,
						reuseExistingServer: reuse,
						timeout: 120_000,
						gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
						stdout: 'pipe',
						stderr: 'pipe',
						name: 'api',
					},
					storefrontServer,
				],
});
