/**
 * ESLint flat config (eslint v9+; ESLint 10 resolves this file for everything under packages/api). The load-bearing
 * rules are `no-restricted-imports` guards for the app's RLS posture (WP1.3): tenant data is read and written through
 * withStore(), never through a raw, unscoped database handle.
 *
 * P8 (G12f): the guard used to cover only `unsafeUnscopedDb` imported by route files. It now covers every raw access
 * path:
 *   1. route files may not import ANY raw handle — `unsafeUnscopedDb`, `pool`, `locksPool` from db/client, nor a
 *      driver (`pg`, `postgres`, `drizzle-orm/node-postgres`) directly. Three route files that predate this rule and
 *      read only global infra tables through `pool` are grandfathered by name below (new uses fail lint);
 *   2. outside routes, `unsafeUnscopedDb` is allowed only in the files listed in
 *      RAW_DB_ALLOWED — infra/auth modules that query RLS-exempt global tables by design. Adding a file to that list is
 *      a reviewed, visible change.
 *
 * Uses the TypeScript parser so files with type-only imports and annotations can be parsed.
 */
import tsParser from '@typescript-eslint/parser';

const RLS_MESSAGE = 'Use withStore() — raw database handles bypass RLS. See docs/ARCHITECTURE.md (WP1.3).';
const DRIVER_MESSAGE = 'Import database access from db/client.js (withStore), never a driver directly. See docs/ARCHITECTURE.md (WP1.3).';

/** no-restricted-imports options forbidding `names` from db/client plus direct driver imports. */
function rawDbRule(names, { drivers = true } = {}) {
  return [
    'error',
    {
      paths: [
        { name: '../db/client.js', importNames: names, message: RLS_MESSAGE },
        { name: '../../db/client.js', importNames: names, message: RLS_MESSAGE },
        { name: './db/client.js', importNames: names, message: RLS_MESSAGE },
        ...(drivers ? [
          { name: 'pg', message: DRIVER_MESSAGE },
          { name: 'postgres', message: DRIVER_MESSAGE },
          { name: 'drizzle-orm/node-postgres', message: DRIVER_MESSAGE },
        ] : []),
      ],
      patterns: [
        { group: ['**/db/client', '**/db/client.js'], importNames: names, message: RLS_MESSAGE },
      ],
    },
  ];
}

/** Route files that read RLS-exempt global tables through `pool` (grandfathered; do not add to this list). */
const ROUTE_POOL_GRANDFATHERED = [
  'src/routes/restock.ts',
  'src/routes/shop-extra.subscriber.ts',
  'src/routes/sheerid.ts',
];

/** Non-route modules allowed raw access (global/RLS-exempt infra, owner-role scripts, the client itself). */
const RAW_DB_ALLOWED = [
  'src/db/**',
  'src/scripts/**',
  'src/sdk/**',
  'src/jobs/passkey-prune.ts',
  'src/payments/stripe.ts',
  'src/auth/setup-claim.ts',
  'src/auth/totp-secret.ts',
  'src/auth/passkeys-admin.ts',
  'src/auth/admin-api-token.ts',
  'src/auth/admin-staff.ts',
  'src/auth/admin-auth-challenge.ts',
  'src/auth/second-factor.ts',
  'src/auth/admin-handoff.ts',
  'src/auth/admin-session.ts',
  'src/licensing/storekit-config.ts',
];

const tsLanguage = {
  parser: tsParser,
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'drizzle/**', 'coverage/**', '*.cjs', '*.mjs', 'src/**/*.test.ts', 'src/**/*.testkit.ts'],
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/routes/**', ...RAW_DB_ALLOWED],
    languageOptions: tsLanguage,
    // Non-route modules legitimately take `pg` types (PoolClient) and dedicated clients; only the unscoped Drizzle
    // handle is gated here.
    rules: { 'no-restricted-imports': rawDbRule(['unsafeUnscopedDb'], { drivers: false }) },
  },
  {
    files: ['src/routes/**/*.ts'],
    ignores: ROUTE_POOL_GRANDFATHERED,
    languageOptions: tsLanguage,
    rules: { 'no-restricted-imports': rawDbRule(['unsafeUnscopedDb', 'pool', 'locksPool']) },
  },
  {
    files: ROUTE_POOL_GRANDFATHERED,
    languageOptions: tsLanguage,
    rules: { 'no-restricted-imports': rawDbRule(['unsafeUnscopedDb', 'locksPool']) },
  },
];
