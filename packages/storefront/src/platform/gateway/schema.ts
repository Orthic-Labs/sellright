// Brand views gateway (docs/plans/2026-10-11-brand-views-gateway.md §1): the data half of the L1 → presentation boundary.
// Every value a gateway handle hands to presentation code is rebuilt here from a fixed schema: new plain objects and arrays all the
// way down, never the caller's objects. Accessors, functions, methods, signals, class instances, symbols, bigints and undeclared keys
// are rejected with a GatewayError, never dropped. Dev and test deep-freeze the copy. The copy is fresh in production too, so a write
// in presentation code only ever touches presentation's own copy.
import { freezeDeep, freezeEnabled } from '~/platform/controllers/project';
import type { SanitizedHtml } from '~/platform/sanitized';

export type Schema =
	| { readonly t: 'string' }
	| { readonly t: 'number' }
	| { readonly t: 'boolean' }
	| { readonly t: 'null' }
	| { readonly t: 'literal'; readonly values: readonly (string | number | boolean)[] }
	| { readonly t: 'array'; readonly of: Schema }
	| { readonly t: 'object'; readonly fields: { readonly [key: string]: Schema | OptionalField } }
	| { readonly t: 'anyOf'; readonly of: readonly Schema[] }
	| { readonly t: 'html' }
	| { readonly t: 'void' };

/** An object field that may be absent or undefined. Only meaningful inside `obj({...})`. */
export interface OptionalField<S extends Schema = Schema> {
	readonly t: 'optional';
	readonly of: S;
}

export const str = { t: 'string' } as const;
export const num = { t: 'number' } as const;
export const bool = { t: 'boolean' } as const;
export const nil = { t: 'null' } as const;
export const html = { t: 'html' } as const;
/** The result of an action that returns nothing: any value the platform function returns is replaced by `undefined`. */
export const VOID = { t: 'void' } as const;
export const lit = <const V extends readonly (string | number | boolean)[]>(...values: V) => ({ t: 'literal', values }) as const;
export const arr = <S extends Schema>(of: S) => ({ t: 'array', of }) as const;
export const obj = <const F extends { readonly [key: string]: Schema | OptionalField }>(fields: F) => ({ t: 'object', fields }) as const;
export const anyOf = <const S extends readonly Schema[]>(...of: S) => ({ t: 'anyOf', of }) as const;
export const opt = <S extends Schema>(of: S): OptionalField<S> => ({ t: 'optional', of });
export const nul = <S extends Schema>(of: S) => anyOf(nil, of);

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type OptionalKeys<F> = { [K in keyof F]: F[K] extends OptionalField ? K : never }[keyof F];
type RequiredKeys<F> = Exclude<keyof F, OptionalKeys<F>>;

/** The readonly TypeScript type a schema accepts and produces. */
export type Infer<S> = S extends { t: 'string' }
	? string
	: S extends { t: 'number' }
		? number
		: S extends { t: 'boolean' }
			? boolean
			: S extends { t: 'null' }
				? null
				: S extends { t: 'void' }
					? void
					: S extends { t: 'html' }
						? SanitizedHtml
						: S extends { t: 'literal'; values: readonly (infer V)[] }
							? V
							: S extends { t: 'array'; of: infer E }
								? readonly Infer<E>[]
								: S extends { t: 'anyOf'; of: readonly (infer U)[] }
									? Infer<U>
									: S extends { t: 'object'; fields: infer F }
										? Simplify<
												{ readonly [K in RequiredKeys<F>]: Infer<F[K]> } & {
													readonly [K in OptionalKeys<F>]?: F[K] extends OptionalField<infer O> ? Infer<O> | undefined : never;
												}
											>
										: never;

/** A value presentation code may not receive. `path` names the prop and the position inside it. */
export class GatewayError extends Error {
	constructor(
		readonly path: string,
		readonly reason: string,
	) {
		super(`gateway: ${path}: ${reason}`);
		this.name = 'GatewayError';
	}
}

const describe = (v: unknown): string => {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	if (typeof v === 'object') {
		const proto = Object.getPrototypeOf(v);
		return proto && proto !== Object.prototype ? `instance of ${proto.constructor?.name ?? 'a class'}` : 'object';
	}
	return typeof v;
};

const isPlainObject = (v: object): boolean => {
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
};

/** Reads an own property, rejecting an accessor before it runs. A normal read keeps Qwik's store tracking. */
function readOwn(source: object, key: PropertyKey, path: string): unknown {
	const desc = Object.getOwnPropertyDescriptor(source, key);
	if (desc && (desc.get || desc.set)) throw new GatewayError(path, 'an accessor (getter/setter) is not data');
	return (source as Record<PropertyKey, unknown>)[key];
}

function copy(schema: Schema, value: unknown, path: string): unknown {
	switch (schema.t) {
		case 'void':
			return undefined;
		case 'string':
		case 'number':
		case 'boolean':
			if (typeof value !== schema.t) throw new GatewayError(path, `expected ${schema.t}, got ${describe(value)}`);
			return value;
		case 'null':
			if (value !== null) throw new GatewayError(path, `expected null, got ${describe(value)}`);
			return null;
		case 'literal':
			if (!schema.values.includes(value as string)) throw new GatewayError(path, `expected one of ${schema.values.map((v) => JSON.stringify(v)).join(', ')}, got ${describe(value)}`);
			return value;
		case 'html': {
			const out = copy(SANITIZED_HTML, value, path) as { kind: string; html: string };
			if (out.kind !== 'sanitized-html') throw new GatewayError(path, 'expected sanitized html');
			return out;
		}
		case 'array': {
			if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new GatewayError(path, `expected array, got ${describe(value)}`);
			const keys = Reflect.ownKeys(value).filter((k) => k !== 'length');
			if (keys.length !== value.length) throw new GatewayError(path, 'an array with holes or extra properties is not data');
			const out: unknown[] = [];
			for (let i = 0; i < value.length; i++) out.push(copy(schema.of, readOwn(value, i, `${path}[${i}]`), `${path}[${i}]`));
			return out;
		}
		case 'object': {
			if (value === null || typeof value !== 'object' || Array.isArray(value) || !isPlainObject(value)) throw new GatewayError(path, `expected a plain object, got ${describe(value)}`);
			for (const key of Reflect.ownKeys(value)) {
				if (typeof key === 'symbol') throw new GatewayError(path, `a symbol key (${String(key)}) is not data`);
				if (!Object.prototype.hasOwnProperty.call(schema.fields, key)) throw new GatewayError(`${path}.${key}`, 'not a declared field');
			}
			const out: Record<string, unknown> = {};
			for (const [key, field] of Object.entries(schema.fields)) {
				const at = `${path}.${key}`;
				const v = Object.prototype.hasOwnProperty.call(value, key) ? readOwn(value, key, at) : undefined;
				if (field.t === 'optional') {
					if (v !== undefined) out[key] = copy(field.of, v, at);
				} else {
					out[key] = copy(field, v, at);
				}
			}
			return out;
		}
		case 'anyOf': {
			const reasons: string[] = [];
			for (const alt of schema.of) {
				try {
					return copy(alt, value, path);
				} catch (e) {
					if (!(e instanceof GatewayError)) throw e;
					reasons.push(`${e.path}: ${e.reason}`);
				}
			}
			throw new GatewayError(path, `matches no alternative (${reasons.join(' | ')})`);
		}
	}
}

const SANITIZED_HTML = obj({ kind: lit('sanitized-html'), html: str });

/** A new value built from `schema`, never sharing an object with `value`. Throws GatewayError instead of dropping anything. */
export function detach<S extends Schema>(schema: S, value: unknown, path: string): Infer<S> {
	return detachValue(schema, value, path) as Infer<S>;
}

/** `detach` for a schema only known as `Schema` (no inferred result type). */
export function detachValue(schema: Schema, value: unknown, path: string): unknown {
	const out = copy(schema, value, path);
	return freezeEnabled() ? freezeDeep(out) : out;
}
