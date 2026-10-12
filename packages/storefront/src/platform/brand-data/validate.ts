// Brand views, plan §1 "Brand data": validates src/brand/head.json and src/brand/routes.json against their JSON schemas and the
// semantic rules (static-schema allowlists, content-path rules). Node build-time code (read by vite-plugin.ts) and unit tests.
import { checkContentPaths, type ContentRoutesInput } from '../content-routes';
import { validateJson, type JsonSchema } from './json-schema';
import { pageSchemasProblems } from './static-schema';
import headSchema from './head.schema.json';
import routesSchema from './routes.schema.json';

export interface BrandDataProblem {
	file: string;
	message: string;
}

export interface ValidateOptions {
	/** Top-level directory names of src/routes (existing routes a content path may not shadow). */
	routeDirs: readonly string[];
	/** True when src/brand-slots/route.content.tsx exists: declared content paths need a view to render. */
	hasContentView: boolean;
}

/** Problems with a parsed head.json value. */
export function validateHeadData(value: unknown): BrandDataProblem[] {
	const file = 'src/brand/head.json';
	const problems = validateJson(value, headSchema as JsonSchema).map((message) => ({ file, message }));
	if (problems.length === 0) {
		for (const message of pageSchemasProblems((value as { pageSchemas?: Record<string, unknown[]> }).pageSchemas)) problems.push({ file, message });
	}
	return problems;
}

/** Problems with a parsed routes.json value. */
export function validateRoutesData(value: unknown, opts: ValidateOptions): BrandDataProblem[] {
	const file = 'src/brand/routes.json';
	const problems = validateJson(value, routesSchema as JsonSchema).map((message) => ({ file, message }));
	if (problems.length > 0) return problems;
	const routes = value as ContentRoutesInput;
	for (const message of checkContentPaths(routes, opts.routeDirs)) problems.push({ file, message });
	if ((routes.content?.length ?? 0) > 0 && !opts.hasContentView) problems.push({ file, message: 'content paths are declared but src/brand-slots/route.content.tsx does not exist; a declared path needs a view' });
	return problems;
}
