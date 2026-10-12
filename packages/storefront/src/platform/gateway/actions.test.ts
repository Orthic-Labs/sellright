// Gateway plan §7 "Actions" (unit): handle construction and checks, argument and result schemas. The rendered paths (SSR,
// resumption, later events, delayed results) are in actions.render.test.tsx.
import { inlinedQrl } from '@qwik.dev/core';
import { describe, expect, it } from 'vitest';
import { ACTIONS, checkHandle, invokeAction, platformAction } from './actions';
import { GatewayError } from './schema';

const qrl = <T extends (...a: never[]) => unknown>(fn: T, sym = 'test_fn') => inlinedQrl(fn, sym);

describe('platformAction / checkHandle', () => {
	it('builds a frozen plain handle that checkHandle accepts for an allowed name', () => {
		const h = platformAction('shell.login', qrl(() => ({ ok: true as const })));
		expect(Object.isFrozen(h)).toBe(true);
		expect(checkHandle(h, ['shell.login'], 'p')).toBe(h);
	});

	it('rejects an unknown action name and a non-QRL implementation', () => {
		expect(() => platformAction('nope' as never, qrl(() => 1) as never)).toThrow(GatewayError);
		expect(() => platformAction('shell.login', (() => ({ ok: true })) as never)).toThrow(/runs a QRL/);
	});

	it('rejects a bare QRL, a forged object, an extra key, an accessor and a name not allowed for the prop', () => {
		const run = qrl(() => undefined);
		expect(() => checkHandle(run, ['ui.press'], 'p')).toThrow(/bare QRL is not a platform action/);
		expect(() => checkHandle({ kind: 'sr-action', name: 'ui.press', run: () => undefined }, ['ui.press'], 'p')).toThrow(/expected a platform action/);
		expect(() => checkHandle({ kind: 'sr-action', name: 'ui.press', run, extra: 1 }, ['ui.press'], 'p')).toThrow(/expected a platform action/);
		const getterHandle = Object.defineProperty({ kind: 'sr-action', name: 'ui.press' }, 'run', { get: () => run, enumerable: true });
		expect(() => checkHandle(getterHandle, ['ui.press'], 'p')).toThrow(/expected a platform action/);
		expect(() => checkHandle(platformAction('ui.press', run), ['shell.login'], 'p')).toThrow(/not allowed here/);
		expect(() => checkHandle(null, ['ui.press'], 'p')).toThrow(/expected a platform action/);
	});
});

describe('invokeAction', () => {
	it('every action in the list has a fixed result schema and argument list', () => {
		for (const spec of Object.values(ACTIONS)) {
			expect(spec.result).toBeTruthy();
			expect(spec.args === 'event' || Array.isArray(spec.args)).toBe(true);
		}
	});

	it('detaches a synchronous and an asynchronous result (new, frozen object)', async () => {
		const own = { ok: true as const };
		const sync = await invokeAction('shell.login', qrl(() => own) as never, []);
		const later = await invokeAction('shell.login', qrl(async () => { await new Promise((r) => setTimeout(r, 5)); return own; }) as never, []);
		for (const r of [sync, later]) {
			expect(r).toEqual({ ok: true });
			expect(r).not.toBe(own);
			expect(Object.isFrozen(r)).toBe(true);
		}
	});

	it('rejects a widened result (an extra field carrying live state) and a wrong shape', async () => {
		const live = { lines: [{ sku: 'A' }] };
		await expect(invokeAction('shell.login', qrl(() => ({ ok: true, cart: live })) as never, [])).rejects.toThrow(/shell\.login result/);
		await expect(invokeAction('loyalty.redeem-toggle', qrl(() => live) as never, [true])).rejects.toThrow(GatewayError);
	});

	it('a void action returns undefined whatever the implementation returns', async () => {
		expect(await invokeAction('ui.press', qrl(() => ({ live: true })) as never, [])).toBeUndefined();
	});

	it('event actions drop the framework-delivered arguments; typed actions check theirs', async () => {
		const seen: unknown[][] = [];
		await invokeAction('ui.press', qrl((...a: unknown[]) => { seen.push(a); }) as never, [{ type: 'click' }, {}]);
		expect(seen).toEqual([[]]);
		await invokeAction('filters.value', qrl((...a: unknown[]) => { seen.push(a); }) as never, ['v1']);
		expect(seen[1]).toEqual(['v1']);
		await expect(invokeAction('filters.value', qrl(() => undefined) as never, [{ id: 'v1' }])).rejects.toThrow(/filters\.value argument 1/);
		await expect(invokeAction('filters.value', qrl(() => undefined) as never, ['a', 'b'])).rejects.toThrow(/expected 1 argument/);
		await expect(invokeAction('cart.quantity-select', qrl(() => undefined) as never, [3, 'quantity-A'])).resolves.toBeUndefined();
		await expect(invokeAction('cart.quantity-select', qrl(() => undefined) as never, ['10+', 'quantity-A'])).resolves.toBeUndefined();
	});
});

describe('invokeAction failures cross detached', () => {
	const live = { countries: [{ code: 'US' }], nested: { deep: [1] } };
	const FAILED = { ok: false, code: 'action-failed', message: "Action 'shell.login' failed." };

	/** The failure must be the fixed shape and share no reference with anything the platform threw. */
	function expectDetached(r: unknown, source: object) {
		expect(r).toEqual(FAILED);
		expect(r).not.toBe(source);
		expect(typeof (r as { message: unknown }).message).toBe('string');
		expect(Object.keys(r as object).sort()).toEqual(['code', 'message', 'ok']);
		expect(Object.isFrozen(r)).toBe(true);
	}

	it('a synchronous throw of live state is mapped, not re-thrown', async () => {
		expectDetached(await invokeAction('shell.login', qrl(() => { throw live; }) as never, []), live);
	});

	it('an async rejection of live state is mapped', async () => {
		expectDetached(await invokeAction('shell.login', qrl(async () => { throw live.countries; }) as never, []), live.countries);
	});

	it('a delayed rejection is mapped', async () => {
		const r = await invokeAction('shell.login', qrl(async () => { await new Promise((x) => setTimeout(x, 5)); throw live; }) as never, []);
		expectDetached(r, live);
	});

	it('an Error carrying live state through cause keeps neither the error, its message nor the cause', async () => {
		const err = Object.assign(new Error('secret message'), { cause: live });
		const r = await invokeAction('shell.login', qrl(() => { throw err; }) as never, []);
		expectDetached(r, err);
		expect(JSON.stringify(r)).not.toContain('secret');
		expect((r as { cause?: unknown }).cause).toBeUndefined();
		expect(r).not.toBe(err.cause);
	});

	it('a void action that throws or rejects is mapped too', async () => {
		const sync = await invokeAction('ui.press', qrl(() => { throw live; }) as never, []);
		const later = await invokeAction('ui.press', qrl(async () => { throw live; }) as never, []);
		for (const r of [sync, later]) {
			expect(r).toEqual({ ok: false, code: 'action-failed', message: "Action 'ui.press' failed." });
			expect(r).not.toBe(live);
		}
	});

	it('a rejection with a primitive or undefined is mapped the same way', async () => {
		expectDetached(await invokeAction('shell.login', qrl(() => { throw 'text'; }) as never, []), live);
		expectDetached(await invokeAction('shell.login', qrl(async () => Promise.reject(undefined)) as never, []), live);
	});
});

