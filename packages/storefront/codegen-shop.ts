import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
	schema: 'src/generated/schema-shop.graphql',
	config: {
		skipDocumentsValidation: {
			skipValidationAgainstSchema: true,
		},
	},
	documents: [
  'src/providers/shop/**/*.{ts,tsx,graphql}',
  'src/services/**/*.graphql',
  '!src/generated/*'
],
	generates: {
		// Types-only target — kept so existing `import { FooQuery } from '~/generated/graphql-shop'`
		// type imports across downstream files keep working without a rename pass.
		'src/generated/graphql-shop.ts': {
			config: {
				enumsAsConst: true,
			},
			plugins: ['typescript', 'typescript-operations'],
		},
		// Phase 3 target — tree-shakable typed-document-node exports.
		'src/generated/graphql-shop-typed.ts': {
			config: {
				enumsAsConst: true,
				documentMode: 'string',
			},
			plugins: ['typescript', 'typescript-operations', 'typed-document-node'],
		},
		'src/generated/schema-shop.graphql': {
			plugins: ['schema-ast'],
		},
	},
};

export default config;
