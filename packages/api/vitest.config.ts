import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // RLS tests share one database and mutate it — never run files in parallel.
    fileParallelism: false,
    // A real Postgres connection per test; give it room.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
