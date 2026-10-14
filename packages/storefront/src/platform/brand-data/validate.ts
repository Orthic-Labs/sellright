// Brand views, plan §1 "Brand data": validates src/brand/head.json and src/brand/routes.json against their JSON schemas and the
// semantic rules (static-schema allowlists, content-path rules). Node build-time code (read by vite-plugin.ts) and unit tests.
import { checkContentPaths, type ContentRoutesInput } from '../content-routes';
import { validateJson, type JsonSchema } from './json-schema';
import { pageSchemasProblems, staticSchemaProblems } from './static-schema';
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
	/** True when src/brand-slots/route.shop.tsx exists: `shop` (detail products, product query) is read only by that view. */
	hasShopView?: boolean;
	/** True when src/brand-slots/route.product.tsx exists. */
	hasProductView?: boolean;
	/** True when src/brand-slots/route.home.tsx exists: `home.spotlight` is read only by that view. */
	hasHomeView?: boolean;
}

/** Collisions an operational alias may not take: the checkout and analytics routes that exist, and the reserved built-ins. */
const RESERVED_CHECKOUT_SEGMENTS = ['confirmation', 'payment', 'cart-link'];
const RESERVED_ANALYTICS_SEGMENTS = ['events'];

interface Pr2Routes {
	productPath?: string;
	shop?: { detailProducts?: { key: string; slug: string; schemas?: unknown[] }[]; productQuery?: { params: string[]; values: Record<string, string> } };
	operational?: { cartSeedPath?: string; analyticsPath?: string };
}

/** PR2 semantic rules: unique keys and slugs, product-query values naming a key, static schemas, operational alias collisions. */
export function pr2RouteProblems(routes: Pr2Routes, opts: Pick<ValidateOptions, 'hasShopView' | 'hasProductView'>): string[] {
	const out: string[] = [];
	const detail = routes.shop?.detailProducts ?? [];
	const keys = new Set<string>();
	const slugs = new Set<string>();
	detail.forEach((p, i) => {
		if (keys.has(p.key)) out.push(`shop.detailProducts[${i}]: key ${p.key} is declared twice`);
		if (slugs.has(p.slug)) out.push(`shop.detailProducts[${i}]: slug ${p.slug} is declared twice`);
		keys.add(p.key);
		slugs.add(p.slug);
		(p.schemas ?? []).forEach((s, j) => out.push(...staticSchemaProblems(s, `shop.detailProducts[${i}].schemas[${j}]`)));
	});
	const query = routes.shop?.productQuery;
	if (query) {
		if (new Set(query.params).size !== query.params.length) out.push('shop.productQuery.params: a param is listed twice');
		for (const [value, key] of Object.entries(query.values)) {
			if (!/^[a-z0-9-]{1,32}$/.test(value)) out.push(`shop.productQuery.values: ${JSON.stringify(value)} is not a lower-case query value`);
			if (!keys.has(key)) out.push(`shop.productQuery.values.${value}: ${key} is not a shop.detailProducts key`);
		}
	}
	if ((routes.shop?.detailProducts || routes.shop?.productQuery) && !opts.hasShopView && !opts.hasProductView) out.push('shop.detailProducts / shop.productQuery are declared but neither src/brand-slots/route.shop.tsx nor route.product.tsx exists; only the brand views read them');
	const seed = routes.operational?.cartSeedPath;
	if (seed && RESERVED_CHECKOUT_SEGMENTS.includes(seed.split('/')[2])) out.push(`operational.cartSeedPath ${seed} collides with an existing checkout route`);
	const sink = routes.operational?.analyticsPath;
	if (sink && RESERVED_ANALYTICS_SEGMENTS.includes(sink.split('/')[3])) out.push(`operational.analyticsPath ${sink} collides with the built-in event sink`);
	return out;
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
	for (const message of pr2RouteProblems(value as Pr2Routes, opts)) problems.push({ file, message });
	if ((value as { home?: { spotlight?: unknown } }).home?.spotlight && opts.hasHomeView === false) problems.push({ file, message: 'home.spotlight is declared but src/brand-slots/route.home.tsx does not exist; only the brand home view sells it' });
	if ((routes.content?.length ?? 0) > 0 && !opts.hasContentView) problems.push({ file, message: 'content paths are declared but src/brand-slots/route.content.tsx does not exist; a declared path needs a view' });
	return problems;
}
