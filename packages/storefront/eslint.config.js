import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import qwikPlugin from 'eslint-plugin-qwik';
import globals from 'globals';

export default [
  // Global ignores (replaces .eslintignore)
  {
    ignores: [
      '**/*.log',
      '**/.DS_Store',
      '.vscode/settings.json',
      '.history',
      '.yarn',
      'bazel-*',
      'bazel-bin',
      'bazel-out',
      'bazel-qwik',
      'bazel-testlogs',
      'dist',
      'dist-dev',
      'lib',
      'etc',
      'external',
      'node_modules',
      'temp',
      'tsc-out',
      'tsdoc-metadata.json',
      'target',
      'output',
      'rollup.config.js',
      'build',
      '.cache',
      '.vscode',
      '.rollup.cache',
      'tsconfig.tsbuildinfo',
      'vite.config.ts',
      'src/generated'
    ]
  },

  // Base JavaScript recommended rules
  js.configs.recommended,
  
  // Configuration for TypeScript and Qwik files
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2021,
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
        // Additional globals
        NodeJS: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'qwik': qwikPlugin,
    },
    rules: {
      // Extend TypeScript recommended rules
      ...tsPlugin.configs.recommended.rules,
      // Extend Qwik recommended rules  
      ...qwikPlugin.configs.recommended.rules,
      
      // Your custom rules (migrated from .eslintrc.cjs)
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-object-type': 'off', // Updated from deprecated no-empty-interface
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/ban-types': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'prefer-spread': 'off',
      'no-case-declarations': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { 
        'argsIgnorePattern': '^_',
        'varsIgnorePattern': '^_',
        'caughtErrorsIgnorePattern': '^_'
      }],
      '@typescript-eslint/no-unused-expressions': ['error', { 
        'allowTaggedTemplates': true,
        'allowShortCircuit': true,
        'allowTernary': true 
      }],
      'qwik/no-use-visible-task': 'off',
      'qwik/loader-location': 'off',
    },
  },
];
