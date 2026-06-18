import type { CodegenConfig } from '@graphql-codegen/cli';
import { DEV_API, LOCAL_API, PROD_API } from './src/constants';

let GRAPHQL_API = import.meta.env.IS_DEV
	? DEV_API
	: import.meta.env.IS_LOCAL
		? LOCAL_API
		: PROD_API;

GRAPHQL_API = `${GRAPHQL_API}/shop-api`;

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
