import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Consumer-contract tests for the SellRight migration: the REST client
 * surface, the server-authoritative cart service, and the NMI Collect.js
 * loader. These run with a mocked fetch — no network, no credentials.
 * The provider-sandbox acceptance suite lives in packages/api
 * (e2e-checkout-gateway.test.ts, SR_GATEWAY_E2E=1 gated).
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    // The virtual brand-data module only exists inside the Vite build; unit tests see "no brand data" (today's defaults).
    alias: {
      'virtual:sellright-brand-data': fileURLToPath(new URL('./src/platform/brand-data/__stubs__/empty.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    testTimeout: 15000,
  },
});
