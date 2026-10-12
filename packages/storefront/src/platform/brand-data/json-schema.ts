// A small JSON-Schema subset validator (type, enum, const, pattern, min/max, items, properties, required, additionalProperties,
// propertyNames, oneOf). The storefront has no schema library dependency, and the brand data files are tiny, so this is
// enough to enforce src/platform/brand-data/*.schema.json with `additionalProperties: false`. Pure; used at build time and in tests.

export interface JsonSchema {
	$ref?: string;
	definitions?: Record<string, JsonSchema>;
	type?: string | string[];
	enum?: unknown[];
	const?: unknown;
	pattern?: string;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	multipleOf?: number;
	items?: JsonSchema;
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean | JsonSchema;
	propertyNames?: { pattern?: string };
	oneOf?: JsonSchema[];
}

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const matchesType = (v: unknown, t: string): boolean => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeOf(v) === t || (t === 'number' && typeOf(v) === 'integer'));

/** Problems of `value` against `schema`, each as `<path>: <message>`; [] when valid. */
export function validateJson(value: unknown, schema: JsonSchema, path = '$', root: JsonSchema = schema): string[] {
	if (schema.$ref !== undefined) {
		const m = /^#\/definitions\/(.+)$/.exec(schema.$ref);
		const target = m ? root.definitions?.[m[1]] : undefined;
		return target ? validateJson(value, target, path, root) : [`${path}: unresolved schema reference ${schema.$ref}`];
	}
	const out: string[] = [];
	if (schema.oneOf) {
		const results = schema.oneOf.map((s) => validateJson(value, s, path, root));
		const ok = results.filter((r) => r.length === 0).length;
		if (ok !== 1) out.push(`${path}: must match exactly one of the allowed shapes${ok === 0 ? ` (${results.map((r) => r[0]).filter(Boolean).join(' | ')})` : ''}`);
		return out;
	}
	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some((t) => matchesType(value, t))) return [`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`];
	}
	if (schema.const !== undefined && value !== schema.const) out.push(`${path}: must be ${JSON.stringify(schema.const)}`);
	if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
	if (typeof value === 'string') {
		if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
		if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
		if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) out.push(`${path}: does not match ${schema.pattern}`);
	}
	if (typeof value === 'number') {
		if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
		if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path}: above ${schema.maximum}`);
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${path}: needs at least ${schema.minItems} item(s)`);
		if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${path}: at most ${schema.maxItems} item(s)`);
		if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) out.push(`${path}: items must be unique`);
		if (schema.items) value.forEach((v, i) => out.push(...validateJson(v, schema.items as JsonSchema, `${path}[${i}]`, root)));
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		for (const key of schema.required ?? []) if (!(key in obj)) out.push(`${path}: missing required "${key}"`);
		for (const [key, v] of Object.entries(obj)) {
			const sub = schema.properties?.[key];
			if (sub) out.push(...validateJson(v, sub, `${path}.${key}`, root));
			else if (schema.additionalProperties === false) out.push(`${path}: unknown property "${key}"`);
			else if (typeof schema.additionalProperties === 'object') out.push(...validateJson(v, schema.additionalProperties, `${path}.${key}`, root));
			if (schema.propertyNames?.pattern && !new RegExp(schema.propertyNames.pattern).test(key)) out.push(`${path}: property name "${key}" does not match ${schema.propertyNames.pattern}`);
		}
	}
	return out;
}
