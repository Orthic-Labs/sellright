import { defineConfig } from '@playwright/test';

/**
 * Config for e2e/prod-smoke.spec.ts only (plan A10). The base playwright.config.ts starts the harness servers and runs a
 * global setup; a smoke run against a live loopback port must start nothing, so it has its own config: no webServer, no
 * globalSetup, no browser project. See the spec's header for the environment variables.
 *
 *   SMOKE_TARGET_URL=http://127.0.0.1:<port> SMOKE_HOST=<domain> pnpm exec playwright test -c e2e/prod-smoke.config.ts
 */
export default defineConfig({
	testDir: '.',
	testMatch: 'prod-smoke.spec.ts',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 30_000,
	reporter: [['list']],
});
