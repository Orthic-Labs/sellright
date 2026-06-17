import { defineConfig } from 'vitest/config';

/**
 * Admin-side unit tests for pure helpers (lib/*). Component / hook tests
 * would also live here once we add them; the runner already supports them.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 10000,
    globals: true,
  },
});
