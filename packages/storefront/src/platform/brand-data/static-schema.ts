// Brand views, plan §2.4 "Static schemas": the JSON-LD a brand may declare per page in head.json `pageSchemas`. Live commerce
// JSON-LD (Product, Offer, ratings) stays platform-owned and is never brand-declared. Pure; build-time and tests.

export const ROOT_TYPES = ['BreadcrumbList', 'AboutPage', 'ContactPage', 'FAQPage', 'WebPage', 'Blog', 'BlogPosting', 'Article', 'Person', 'Organization'] as const;
export const NESTED_TYPES = ['ListItem', 'Question', 'Answer', 'Organization', 'Person', 'ImageObject', 'WebPage', 'PostalAddress', 'ContactPoint'] as const;
export const FORBIDDEN_TYPES = ['Product', 'ProductGroup', 'Offer', 'AggregateOffer', 'AggregateRating', 'Review'] as const;
const FORBIDDEN_KEY = /^(offers|price.*|availability|aggregateRating|review|sku|gtin.*|mpn)$/i;

export const MAX_STRING = 2000;
export const MAX_DEPTH = 6;
export const MAX_SCHEMAS_PER_PATH = 20;

const asTypes = (t: unknown): string[] | null => (typeof t === 'string' ? [t] : Array.isArray(t) && t.every((x) => typeof x === 'string') ? (t as string[]) : null);

/** Problems with one declared schema object (root), or []. `where` prefixes every message. */
export function staticSchemaProblems(schema: unknown, where: string): string[] {
	const out: string[] = [];
	const walk = (node: unknown, path: string, depth: number, root: boolean): void => {
		if (depth > MAX_DEPTH) { out.push(`${path}: nested deeper than ${MAX_DEPTH}`); return; }
		if (typeof node === 'string') { if (node.length > MAX_STRING) out.push(`${path}: string longer than ${MAX_STRING}`); return; }
		if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`, depth + 1, false)); return; }
		if (!node || typeof node !== 'object') return;
		const obj = node as Record<string, unknown>;
		const keys = Object.keys(obj);
		for (const key of keys) if (FORBIDDEN_KEY.test(key)) out.push(`${path}.${key}: price, availability, offers, ratings, reviews and product identifiers are platform-owned`);
		const types = '@type' in obj ? asTypes(obj['@type']) : null;
		if ('@type' in obj && !types) out.push(`${path}.@type: must be a string or a list of strings`);
		for (const t of types ?? []) {
			if ((FORBIDDEN_TYPES as readonly string[]).includes(t)) out.push(`${path}.@type ${t}: a commerce type is platform-owned`);
			else if (root && !(ROOT_TYPES as readonly string[]).includes(t)) out.push(`${path}.@type ${t}: not an allowed root type (${ROOT_TYPES.join(', ')})`);
			else if (!root && !(NESTED_TYPES as readonly string[]).includes(t)) out.push(`${path}.@type ${t}: not an allowed nested type (${NESTED_TYPES.join(', ')})`);
		}
		if (root && !types) out.push(`${path}: a root schema needs an @type`);
		if (!root && !types && !(keys.length === 1 && keys[0] === '@id')) {
			// a nested plain object (e.g. a `name` object) must still be an allowed type or an @id-only reference
			if (keys.some((k) => k !== '@id' && k !== '@context')) out.push(`${path}: a nested object needs an allowed @type or must be an @id-only reference`);
		}
		for (const key of keys) walk(obj[key], `${path}.${key}`, depth + 1, false);
	};
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${where}: a schema must be an object`];
	walk(schema, where, 1, true);
	return out;
}

/** Problems with every path's schema list, or []. */
export function pageSchemasProblems(pageSchemas: Record<string, unknown[]> | undefined): string[] {
	const out: string[] = [];
	for (const [path, list] of Object.entries(pageSchemas ?? {})) {
		if (list.length > MAX_SCHEMAS_PER_PATH) out.push(`pageSchemas ${path}: more than ${MAX_SCHEMAS_PER_PATH} schemas`);
		list.forEach((s, i) => out.push(...staticSchemaProblems(s, `pageSchemas[${path}][${i}]`)));
	}
	return out;
}
