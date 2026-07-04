import { defineConfig } from 'vitest/config';

/**
 * Admin-side unit tests for pure helpers (lib/*). Component / hook tests
 * would also live here once we add them; the runner already supports them.
 *
 * `pool: 'threads'` is required so jsdom-environment tests (ErrorBoundary.test)
 * can spin up cleanly on Windows — the default 'forks' pool times out waiting
 * for the jsdom-enabled worker to respond in this environment.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 10000,
    globals: true,
    pool: 'threads',
  },
});
