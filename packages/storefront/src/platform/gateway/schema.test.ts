// Gateway plan §7 "Schema unit": what the data half of the gateway accepts, copies and rejects.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayError, VOID, anyOf, arr, bool, detach, html, lit, nul, num, obj, opt, str } from './schema';

const LINE = obj({ sku: str, quantity: num, meta: obj({ tag: str }), note: opt(nul(str)) });

afterEach(() => vi.unstubAllEnvs());

const objectsOf = (v: unknown, out = new Set<object>()): Set<object> => {
	if (v && typeof v === 'object' && !out.has(v)) {
		out.add(v);
		for (const x of Object.values(v)) objectsOf(x, out);
	}
	return out;
};

describe('detach: accepted data is a new value', () => {
	it('copies nested objects and arrays recursively (no shared identity) and freezes them in test', () => {
		const src = { lines: [{ sku: 'A', quantity: 1, meta: { tag: 'x' } }] };
		const out = detach(obj({ lines: arr(LINE) }), src, 'p');
		expect(out).toEqual(src);
		const fresh = objectsOf(out);
		for (const o of objectsOf(src)) expect(fresh.has(o)).toBe(false);
		for (const o of fresh) expect(Object.isFrozen(o)).toBe(true);
		expect(Object.isFrozen(src.lines[0])).toBe(false);
	});

	it('production: a fresh unfrozen copy; writing it never touches the source', () => {
		vi.stubEnv('DEV', false);
		vi.stubEnv('MODE', 'production');
		const src = { sku: 'A', quantity: 1, meta: { tag: 'x' } };
		const out = detach(LINE, src, 'p') as { meta: { tag: string } };
		expect(Object.isFrozen(out)).toBe(false);
		out.meta.tag = 'changed';
		expect(src.meta.tag).toBe('x');
	});

	it('a shallow copy of a live object still gets a new nested object', () => {
		const live = { sku: 'A', quantity: 1, meta: { tag: 'x' } };
		const shallow = { ...live };
		const out = detach(LINE, shallow, 'p');
		expect(out.meta).not.toBe(live.meta);
	});

	it('optional fields may be absent or undefined and are then omitted; null passes where declared', () => {
		expect(detach(LINE, { sku: 'A', quantity: 1, meta: { tag: 'x' }, note: undefined }, 'p')).toEqual({ sku: 'A', quantity: 1, meta: { tag: 'x' } });
		expect(detach(LINE, { sku: 'A', quantity: 1, meta: { tag: 'x' }, note: null }, 'p')).toEqual({ sku: 'A', quantity: 1, meta: { tag: 'x' }, note: null });
	});

	it('null-prototype objects are plain data', () => {
		const o = Object.assign(Object.create(null), { tag: 'x' });
		expect(detach(obj({ tag: str }), o, 'p')).toEqual({ tag: 'x' });
	});

	it('anyOf picks the first alternative that fits; literals; sanitized html; void drops the value', () => {
		const R = anyOf(obj({ ok: lit(true) }), obj({ ok: lit(false), reason: lit('busy') }));
		expect(detach(R, { ok: false, reason: 'busy' }, 'r')).toEqual({ ok: false, reason: 'busy' });
		expect(detach(html, { kind: 'sanitized-html', html: '<p>x</p>' }, 'b')).toEqual({ kind: 'sanitized-html', html: '<p>x</p>' });
		expect(detach(VOID, { live: true }, 'v')).toBeUndefined();
	});
});

describe('detach: rejected, never silently dropped', () => {
	class Box {
		sku = 'A';
	}
	const signalLike = new (class Signal {
		value = 1;
	})();
	const cases: [string, unknown, unknown, RegExp][] = [
		['a getter', obj({ tag: str }), { get tag() { return 'x'; } }, /accessor/],
		['a setter', obj({ tag: str }), Object.defineProperty({}, 'tag', { set() {}, enumerable: true }), /accessor/],
		['a getter on an array element', arr(str), Object.defineProperty(['a'], 0, { get: () => 'x' }), /accessor/],
		['a method', obj({ tag: str }), { tag: 'x', get2() { return 1; } }, /not a declared field/],
		['a function value', obj({ tag: str }), { tag: () => 'x' }, /expected string/],
		['a class instance', obj({ sku: str }), new Box(), /plain object/],
		['a signal-like instance', obj({ value: num }), signalLike, /plain object/],
		['a Map', obj({}), new Map(), /plain object/],
		['a Date', obj({}), new Date(), /plain object/],
		['a symbol key', obj({}), { [Symbol('s')]: 1 }, /symbol key/],
		['a symbol value', str, Symbol('s'), /expected string/],
		['a bigint', num, BigInt(1), /expected number/],
		['an undeclared key', obj({ tag: str }), { tag: 'x', secret: { token: 't' } }, /not a declared field/],
		['a missing required field', obj({ tag: str }), {}, /expected string/],
		// eslint-disable-next-line no-sparse-arrays
		['a sparse array', arr(num), [1, , 3], /holes/],
		['an array with an extra property', arr(num), Object.assign([1], { extra: 1 }), /holes or extra/],
		['an array subclass', arr(num), new (class Arr extends Array<number> {})(), /expected array/],
		['a wrong literal', lit('a', 'b'), 'c', /expected one of/],
		['a forged sanitized html', html, { kind: 'raw', html: '<script>' }, /matches no alternative|expected one of/],
		['a bool for a number', num, true, /expected number/],
		['null for a non-null', obj({ tag: str }), null, /plain object/],
	];
	for (const [name, schema, value, reason] of cases) {
		it(name, () => {
			let err: unknown;
			try {
				detach(schema as never, value, 'prop');
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(GatewayError);
			expect(String((err as Error).message)).toMatch(reason);
		});
	}

	it('the error names the prop path', () => {
		expect(() => detach(obj({ lines: arr(LINE) }), { lines: [{ sku: 'A', quantity: 1, meta: { tag: 1 } }] }, 'Card.data')).toThrow(/Card\.data\.lines\[0\]\.meta\.tag/);
	});

	it('a getter is rejected before it runs', () => {
		let ran = false;
		expect(() =>
			detach(obj({ v: num }), {
				get v() {
					ran = true;
					return 1;
				},
			}, 'p'),
		).toThrow(GatewayError);
		expect(ran).toBe(false);
	});

	it('bool and nul combinators', () => {
		expect(detach(nul(bool), null, 'p')).toBeNull();
		expect(detach(nul(bool), true, 'p')).toBe(true);
	});
});
