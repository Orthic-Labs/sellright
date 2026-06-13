/**
 * ESLint flat config (eslint v9). The single non-obvious rule is the
 * `no-restricted-imports` for `unsafeUnscopedDb` under `src/routes/` — that
 * is the belt-and-suspenders for WP1.3 (the app's RLS posture). A route file
 * that accidentally imports the unscoped client fails lint, which fails
 * `pnpm verify`. The migration and the seed scripts may import it (they run
 * as the owner role by design).
 *
 * No typescript-eslint dep — just the stock flat config. The repo doesn't
 * run `pnpm lint` in CI today; this config is here to be used when that
 * hook is added. The no-restricted-imports rule is the load-bearing piece.
 */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'drizzle/**', 'coverage/**', '*.cjs', '*.mjs'],
  },
  {
    files: ['src/routes/**/*.ts'],
    rules: {
      // WP1.3 seal: route handlers must use withStore() for tenant queries.
      // `unsafeUnscopedDb` is allowed in migrations, seed, and the jobs/ that
      // set their own per-store context, but never in a route file.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '../db/client.js',
              importNames: ['unsafeUnscopedDb'],
              message: 'Route handlers must use withStore() — unsafeUnscopedDb bypasses RLS. See docs/ARCHITECTURE.md.',
            },
            {
              name: '../../db/client.js',
              importNames: ['unsafeUnscopedDb'],
              message: 'Route handlers must use withStore() — unsafeUnscopedDb bypasses RLS. See docs/ARCHITECTURE.md.',
            },
          ],
          patterns: [
            {
              group: ['**/db/client'],
              importNames: ['unsafeUnscopedDb'],
              message: 'Route handlers must use withStore() — unsafeUnscopedDb bypasses RLS. See docs/ARCHITECTURE.md.',
            },
          ],
        },
      ],
    },
  },
];
