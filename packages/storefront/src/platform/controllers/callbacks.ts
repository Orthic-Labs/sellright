// Brand views, plan §1 "Platform callbacks (direct, awaited, serialised)". Every action prop a controller hands a brand view is
// `$((...args) => dispatch(ctl, key, results, () => method(...args)))`:
//   - `ctl` is the controller's private store; `method` is a plain L1 function that validates its arguments against `ctl`.
//   - Calls apply strictly in call order, including calls made back-to-back before any await and calls made while an earlier
//     async method is running (one promise chain per controller). A rejected or thrown method never blocks later calls.
//   - Methods never throw to the brand: every outcome is a typed result; the promise resolves AFTER the state change is applied.
//   - Admission guard (plan v3.1): `busy` is decided synchronously when the action is called, BEFORE it is queued and never inside
//     the chain, from the guard keys ('submit', 'add', 'redeem') already admitted (running or queued). A busy call makes no request.
//     A key is released when its call's promise settles.
//   - On unmount `ctl.disposed = true`: queued methods resolve `disposed` without effects.
// Methods never call other actions, so the chain cannot deadlock.
// Results (gateway plan §3, ruling step 3): what a method returns never reaches the caller as is. It is rebuilt from the dispatch's
// fixed result schema (a new detached value); a result the schema rejects resolves `error`.
import { ACTION_RESULT } from '~/platform/gateway/actions';
import { detachValue, type Schema } from '~/platform/gateway/schema';

export type { ActionResult, FormResult } from '~/platform/views';

/** The part of a controller's private store the dispatcher needs. A Qwik `useStore` proxy satisfies it. */
export interface ActionCtl {
	disposed: boolean;
	/** Guard keys of calls that are running or queued. */
	admitted: string[];
}

export interface DispatchResults<R> {
	busy: R;
	disposed: R;
	error: R;
	/** The fixed schema every method result is rebuilt from. */
	schema: Schema;
}

export const ACTION_RESULTS: DispatchResults<{ ok: false; reason: 'busy' | 'disposed' | 'error' }> = {
	busy: { ok: false, reason: 'busy' },
	disposed: { ok: false, reason: 'disposed' },
	error: { ok: false, reason: 'error' },
	schema: ACTION_RESULT,
};

const noop = () => undefined;

// Module-level and browser-only in practice: controllers dispatch from event handlers. A WeakMap, so a disposed controller's chain is collectable.
const chains = new WeakMap<object, Promise<unknown>>();

/** Runs `fn` after every earlier call for `key` has settled; its own failure never blocks the next call. */
export function serial<T>(key: object, fn: () => T | Promise<T>): Promise<T> {
	const run = (chains.get(key) ?? Promise.resolve()).then(fn);
	chains.set(key, run.then(noop, noop));
	return run;
}

/**
 * The single entry every action prop goes through. `guard` null = an unguarded action (selection, toggle): ordered but never busy.
 */
export function dispatch<R>(ctl: ActionCtl, guard: string | null, results: DispatchResults<R>, method: () => R | Promise<R>): Promise<R> {
	if (guard !== null) {
		if (ctl.admitted.includes(guard)) return Promise.resolve(results.busy);
		ctl.admitted.push(guard);
	}
	const release = () => {
		if (guard === null) return;
		const i = ctl.admitted.indexOf(guard);
		if (i >= 0) ctl.admitted.splice(i, 1);
	};
	return serial(ctl, async () => {
		if (ctl.disposed) return results.disposed;
		try {
			return detachValue(results.schema, await method(), 'dispatch result') as R;
		} catch {
			return results.error;
		}
	}).then(
		(r) => {
			release();
			return r;
		},
		(e) => {
			release();
			throw e; // unreachable: the chain body never rejects
		},
	);
}
