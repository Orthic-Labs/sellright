import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.audit/**',
      '**/.agent/**',
      '**/.cache/**',
      '**/drizzle/**',
      '**/src/generated/**',
      '**/*.config.*',
      'packages/admin/**',
      'packages/storefront/**',
      'packages/shared/**',
      'packages/api/scripts/**',
      'packages/api/scripts-deploy/**',
      'packages/api/src/**/*.test.ts',
    ],
  },
  {
    files: ['packages/api/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
  },
  {
    files: ['packages/api/src/routes/**/*.ts'],
    rules: {
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
