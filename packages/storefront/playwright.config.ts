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
import { API_TAP, API_URL, CATALOG_DIR, EXTERNAL_API, FS_LOG_FILE, MOCK_PORT, SHOP_API_URL, STORE_PORT, STORE_URL, SUPPORT_DIR, TAP_URL, assertSafeTargets } from './e2e/support/env.mjs';

assertSafeTargets();

// Every webServer command is built from SUPPORT_DIR (E2E_SUPPORT_DIR, default e2e/support of this checkout), so a run
// can use the support files of a pinned read-only checkout; see e2e/support/env.mjs for the E2E_* overrides.
const support = (file: string) => JSON.stringify(`${SUPPORT_DIR}/${file}`);

// Dev loop: E2E_REUSE_SERVERS=1 keeps an already-running mock/API/storefront triple (the API database is NOT reset).
const reuse = !!process.env.E2E_REUSE_SERVERS && !process.env.CI;

// Recording reverse proxy in front of the API (E2E_API_TAP=1). Started after the API, before the storefront.
const apiTap = {
	command: `node ${support('api-tap.mjs')}`,
	url: `${TAP_URL}/__tap/health`,
	reuseExistingServer: reuse,
	timeout: 30_000,
	gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
	stdout: 'pipe' as const,
	stderr: 'pipe' as const,
	name: 'api-tap',
};

const storefrontServer = {
	// `pnpm run e2e:build` (part of `pnpm test:e2e`) builds server-e2e/dist-e2e: the production build with SSG off, so
	// every page renders from THIS suite's API instead of a snapshot of whatever store was live at build time.
	command: `node ${process.env.E2E_STORE_SERVER ?? 'server-e2e/entry.express.js'}`,
	// E2E_STORE_READY_PATH: a page that renders before global setup seeds the catalog (the license-flow build's home reads a
	// collection that global setup has not created yet).
	url: STORE_URL + (process.env.E2E_STORE_READY_PATH ?? ''),
	// The storefront server is stateless, so a developer's already-running build can always be reused.
	reuseExistingServer: !process.env.CI,
	timeout: 60_000,
	name: 'storefront',
	env: {
		PORT: String(STORE_PORT),
		HOST: '127.0.0.1',
		NODE_ENV: 'production',
		// The API tap (E2E_API_TAP=1) sits between the storefront and the API so server-side calls are recorded too.
		SELLRIGHT_API_URL: SHOP_API_URL,
		// Never inherit the operator's published catalog snapshot (a real store's manifest would shadow this
		// suite's database): with no directory the shop reads the live API, which is what a fresh CI store does.
		// E2E_CATALOG_DIR opts in to the harness-owned directory the real publisher writes (see start-api.mjs).
		CATALOG_DIR: CATALOG_DIR ?? '',
		// fs tap (E2E_FS_TAP=1): records every marker.json / shop-catalog*.json read of the storefront server.
		...(process.env.E2E_FS_TAP === '1' ? { E2E_FS_LOG: FS_LOG_FILE, NODE_OPTIONS: `--import=${SUPPORT_DIR}/fs-tap.mjs` } : {}),
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
			? [...(API_TAP ? [apiTap] : []), storefrontServer]
			: [
					{
						// Mock NMI + Sezzle + webhook receiver + SMTP sink: the only "gateways" the API can reach.
						command: `node ${support('mock-gateways.mjs')}`,
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
						command: `node ${support('start-api.mjs')}`,
						url: `${API_URL}/v1/readyz`,
						reuseExistingServer: reuse,
						timeout: 120_000,
						gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
						stdout: 'pipe',
						stderr: 'pipe',
						name: 'api',
					},
					...(API_TAP ? [apiTap] : []),
					storefrontServer,
				],
});
