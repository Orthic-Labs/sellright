import { defineConfig, devices } from '@playwright/test';
import { ADMIN_PORT, ADMIN_URL, API_PORT, API_URL, AUTH_FILE, assertSafeTargets } from './e2e/support/env.mjs';

/**
 * Browser e2e for the SellRight admin SPA, modelled on packages/storefront/playwright.config.ts:
 * the *production build* of the app under test (dist-e2e, built by `pnpm test:e2e`), a real API,
 * one worker (a single shared database backs every spec).
 *
 *   webServer[0]  throwaway API from packages/api/dist on :3399 — start-api.mjs drops/recreates
 *                 `sellright_admin_e2e`, migrates, bootstraps the store + owner, then serves.
 *   webServer[1]  `vite preview` serving dist-e2e with /v1 + /assets proxied to that API
 *                 (preview.proxy defaults to the same server.proxy the real dev flow uses).
 *   globalSetup   seeds the catalog over the admin API and stores the owner's signed-in state.
 *
 * Never points at :3300, sellright_dev, dd_sellright, rh_sellright, sellright_demo or rightsites
 * (assertSafeTargets enforces it for every DB URL).
 */
assertSafeTargets();

// Dev loop: E2E_REUSE_SERVERS=1 keeps an already-running API/admin pair (database NOT reset; specs use unique tags).
const reuse = !!process.env.E2E_REUSE_SERVERS && !process.env.CI;

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.spec.ts',
	globalSetup: './e2e/support/global-setup.ts',
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: process.env.CI ? [['github'], ['html', { open: 'never' }], ['list']] : [['list']],
	timeout: 45_000,
	expect: { timeout: 8_000 },
	use: {
		baseURL: ADMIN_URL,
		storageState: AUTH_FILE,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		acceptDownloads: true,
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: [
		{
			command: 'node e2e/support/start-api.mjs',
			url: `${API_URL}/v1/readyz`,
			reuseExistingServer: reuse,
			timeout: 120_000,
			gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
			stdout: 'pipe',
			stderr: 'pipe',
			name: 'api',
		},
		{
			command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${ADMIN_PORT} --strictPort`,
			url: ADMIN_URL,
			reuseExistingServer: reuse,
			timeout: 60_000,
			env: { SELLRIGHT_API_ORIGIN: API_URL, SELLRIGHT_BUILD_SUFFIX: 'e2e' },
			name: 'admin',
		},
	],
});
