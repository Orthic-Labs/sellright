import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { qwikVite } from '@qwik.dev/core/optimizer';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Render tests (`*.render.test.tsx`): real Qwik components through the optimizer, rendered with @qwik.dev/core/testing (SSR,
 * resumption, client events). Used for the brand-views gateway (docs/plans/2026-10-11-brand-views-gateway.md §7). The virtual
 * brand modules are stubs: no brand data, and the shipped default slots (src/brand-slots).
 */
export default defineConfig({
  plugins: [qwikVite(), tsconfigPaths()],
  resolve: {
    alias: {
      'virtual:sellright-brand-data': fileURLToPath(new URL('./src/platform/brand-data/__stubs__/empty.ts', import.meta.url)),
      'virtual:sellright-brand-slots': fileURLToPath(new URL('./src/platform/gateway/__stubs__/brand-slots.ts', import.meta.url)),
    },
  },
  // A merchant id turns the shipped payment slots on, so their markup (not just their absence) is compared.
  test: { environment: 'node', include: ['src/**/*.render.test.tsx'], testTimeout: 30000, env: { VITE_SEZZLE_MERCHANT_UUID: 'render-test-merchant' } },
});
