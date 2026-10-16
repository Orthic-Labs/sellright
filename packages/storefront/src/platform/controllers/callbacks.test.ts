// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ACTION_RESULTS, dispatch, serial, type ActionCtl } from './callbacks';

const newCtl = (): ActionCtl => ({ disposed: false, admitted: [] });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
};

describe('serial', () => {
	it('applies calls strictly in call order, even when issued back to back without awaiting', async () => {
		const ctl = {};
		const log: string[] = [];
		const a = serial(ctl, async () => { await tick(); log.push('a'); return 1; });
		const b = serial(ctl, () => { log.push('b'); return 2; });
		const c = serial(ctl, async () => { log.push('c'); return 3; });
		expect(await Promise.all([a, b, c])).toEqual([1, 2, 3]);
		expect(log).toEqual(['a', 'b', 'c']);
	});

	it('a rejected method does not block later calls', async () => {
		const ctl = {};
		const bad = serial(ctl, () => { throw new Error('boom'); });
		const good = serial(ctl, () => 'ok');
		await expect(bad).rejects.toThrow('boom');
		await expect(good).resolves.toBe('ok');
	});

	it('controllers do not share a chain', async () => {
		const gate = deferred();
		const log: string[] = [];
		const slow = serial({}, async () => { await gate.promise; log.push('slow'); });
		await serial({}, () => { log.push('other'); });
		expect(log).toEqual(['other']);
		gate.resolve();
		await slow;
		expect(log).toEqual(['other', 'slow']);
	});
});

describe('dispatch', () => {
	it('onA(1); onB() issued without awaiting apply in order and each resolves after its state change', async () => {
		const ctl = newCtl();
		const state = { quantity: 0, added: 0 };
		const onQuantity = (n: number) => dispatch(ctl, null, ACTION_RESULTS as never, async () => { await tick(); state.quantity = n; return { ok: true as const }; });
		const onAdd = () => dispatch(ctl, 'add', ACTION_RESULTS as never, () => { state.added = state.quantity; return { ok: true as const }; });
		const q = onQuantity(2);
		const add = onAdd();
		expect(state).toEqual({ quantity: 0, added: 0 });
		expect(await q).toEqual({ ok: true });
		expect(state.quantity).toBe(2);
		expect(await add).toEqual({ ok: true });
		expect(state.added).toBe(2);
	});

	it('a call made during a pending async method runs after it', async () => {
		const ctl = newCtl();
		const gate = deferred();
		const log: string[] = [];
		const first = dispatch(ctl, null, ACTION_RESULTS as never, async () => { log.push('first:start'); await gate.promise; log.push('first:end'); return { ok: true }; });
		await tick();
		const second = dispatch(ctl, null, ACTION_RESULTS as never, () => { log.push('second'); return { ok: true }; });
		await tick();
		expect(log).toEqual(['first:start']);
		gate.resolve();
		await Promise.all([first, second]);
		expect(log).toEqual(['first:start', 'first:end', 'second']);
	});

	it('a throwing method resolves `error` and the next call still runs', async () => {
		const ctl = newCtl();
		const bad = await dispatch(ctl, null, ACTION_RESULTS as never, () => { throw new Error('x'); });
		expect(bad).toEqual({ ok: false, reason: 'error' });
		const good = await dispatch(ctl, null, ACTION_RESULTS as never, () => ({ ok: true }));
		expect(good).toEqual({ ok: true });
	});

	it('a rejected async method resolves `error`', async () => {
		const ctl = newCtl();
		expect(await dispatch(ctl, 'submit', ACTION_RESULTS as never, () => Promise.reject(new Error('x')))).toEqual({ ok: false, reason: 'error' });
		expect(ctl.admitted).toEqual([]);
	});

	it('after dispose, queued calls resolve `disposed` without running the method', async () => {
		const ctl = newCtl();
		const gate = deferred();
		let ran = 0;
		const first = dispatch(ctl, null, ACTION_RESULTS as never, async () => { await gate.promise; ran++; return { ok: true }; });
		const queued = dispatch(ctl, null, ACTION_RESULTS as never, () => { ran++; return { ok: true }; });
		await tick(); // `first` is now running (it already passed the disposed check)
		ctl.disposed = true;
		gate.resolve();
		expect(await first).toEqual({ ok: true });
		expect(await queued).toEqual({ ok: false, reason: 'disposed' });
		expect(ran).toBe(1);
		expect(await dispatch(ctl, null, ACTION_RESULTS as never, () => { ran++; return { ok: true }; })).toEqual({ ok: false, reason: 'disposed' });
		expect(ran).toBe(1);
	});

	describe('admission guard (v3.1): busy is decided before queueing', () => {
		it('a second submit made while the first is still running is busy and never runs', async () => {
			const ctl = newCtl();
			const gate = deferred();
			let requests = 0;
			const submit = () => dispatch(ctl, 'submit', ACTION_RESULTS as never, async () => { requests++; await gate.promise; return { ok: true }; });
			const first = submit();
			const second = submit();
			expect(await second).toEqual({ ok: false, reason: 'busy' });
			gate.resolve();
			expect(await first).toEqual({ ok: true });
			expect(requests).toBe(1);
		});

		it('a submit queued behind another action (not yet started) still blocks a second submit', async () => {
			const ctl = newCtl();
			const gate = deferred();
			let requests = 0;
			const select = dispatch(ctl, null, ACTION_RESULTS as never, async () => { await gate.promise; return { ok: true }; });
			const first = dispatch(ctl, 'submit', ACTION_RESULTS as never, () => { requests++; return { ok: true }; });
			const second = dispatch(ctl, 'submit', ACTION_RESULTS as never, () => { requests++; return { ok: true }; });
			expect(await second).toEqual({ ok: false, reason: 'busy' });
			gate.resolve();
			await Promise.all([select, first]);
			expect(requests).toBe(1);
		});

		it('two consecutive adds issued back to back execute once', async () => {
			const ctl = newCtl();
			let adds = 0;
			const add = () => dispatch(ctl, 'add', ACTION_RESULTS as never, async () => { await tick(); adds++; return { ok: true }; });
			const results = await Promise.all([add(), add()]);
			expect(results).toEqual([{ ok: true }, { ok: false, reason: 'busy' }]);
			expect(adds).toBe(1);
		});

		it('the key is released when the call settles, so a later submit runs; different keys never block each other', async () => {
			const ctl = newCtl();
			expect(await dispatch(ctl, 'submit', ACTION_RESULTS as never, () => ({ ok: true }))).toEqual({ ok: true });
			expect(ctl.admitted).toEqual([]);
			expect(await dispatch(ctl, 'submit', ACTION_RESULTS as never, () => ({ ok: true }))).toEqual({ ok: true });
			const gate = deferred();
			const a = dispatch(ctl, 'submit', ACTION_RESULTS as never, async () => { await gate.promise; return { ok: true }; });
			const b = dispatch(ctl, 'redeem', ACTION_RESULTS as never, () => ({ ok: true }));
			gate.resolve();
			expect(await Promise.all([a, b])).toEqual([{ ok: true }, { ok: true }]);
		});

		it('the key is released after a throw and after dispose', async () => {
			const ctl = newCtl();
			await dispatch(ctl, 'submit', ACTION_RESULTS as never, () => { throw new Error('x'); });
			expect(ctl.admitted).toEqual([]);
			ctl.disposed = true;
			await dispatch(ctl, 'submit', ACTION_RESULTS as never, () => ({ ok: true }));
			expect(ctl.admitted).toEqual([]);
		});
	});
});

// Gateway plan §3 (ruling step 3): a method's result never reaches the caller as is; it is rebuilt from the dispatch's fixed schema.
describe('dispatch result schema', () => {
	it('returns a new frozen copy of the method result, never the method’s own object', async () => {
		const own = { ok: true as const };
		const r = await dispatch(newCtl(), null, ACTION_RESULTS as never, () => own);
		expect(r).toEqual({ ok: true });
		expect(r).not.toBe(own);
		expect(Object.isFrozen(r)).toBe(true);
	});

	it('a result the schema rejects (a widened result carrying live state, or a wrong shape) resolves `error`', async () => {
		const live = { lines: [{ sku: 'A' }] };
		expect(await dispatch(newCtl(), null, ACTION_RESULTS as never, () => ({ ok: true, cart: live }))).toEqual({ ok: false, reason: 'error' });
		expect(await dispatch(newCtl(), null, ACTION_RESULTS as never, async () => live)).toEqual({ ok: false, reason: 'error' });
		expect(await dispatch(newCtl(), null, ACTION_RESULTS as never, () => ({ ok: false, reason: 'turnstile' }))).toEqual({ ok: false, reason: 'error' });
	});

	it('a rejected result still releases the guard and keeps the order', async () => {
		const ctl = newCtl();
		const log: string[] = [];
		const a = dispatch(ctl, 'submit', ACTION_RESULTS as never, async () => { await tick(); log.push('a'); return { ok: true, extra: 1 }; });
		const b = dispatch(ctl, null, ACTION_RESULTS as never, () => { log.push('b'); return { ok: true }; });
		expect(await a).toEqual({ ok: false, reason: 'error' });
		expect(await b).toEqual({ ok: true });
		expect(log).toEqual(['a', 'b']);
		expect(ctl.admitted).toEqual([]);
	});
});
