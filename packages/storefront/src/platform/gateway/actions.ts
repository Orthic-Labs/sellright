// Brand views gateway (plan §1, §3): the action half of the L1 → presentation boundary. Presentation code receives only actions the
// platform created with `platformAction(name, qrl)`, from the fixed list below. The gateway re-wraps each one (gate.tsx `bindAction`),
// so the arguments presentation passes and every result it gets back, synchronous or asynchronous, go through the action's fixed
// schemas: a result is a new detached value, never the platform's own object. A handle is a plain serialisable object holding a QRL,
// so it survives SSR and resumption without any in-memory registry; `gateway-action-literal` (scripts/check-gateway.mjs) keeps this
// file its only constructor.
import type { QRL } from '@qwik.dev/core';
import { GatewayError, VOID, anyOf, bool, detachValue, lit, num, obj, str, type Infer, type Schema } from './schema';

export const ACTION_RESULT = anyOf(obj({ ok: lit(true) }), obj({ ok: lit(false), reason: lit('invalid', 'busy', 'disposed', 'error') }));
export const FORM_RESULT = anyOf(obj({ ok: lit(true) }), obj({ ok: lit(false), reason: lit('invalid', 'busy', 'turnstile', 'server', 'disposed') }));

interface ActionSpec {
	/** 'event': a DOM handler; the framework-delivered arguments are not forwarded. Otherwise one schema per argument. */
	readonly args: 'event' | readonly Schema[];
	readonly result: Schema;
}

/** Every action presentation code can be given. Adding one is a reviewed platform change. */
export const ACTIONS = {
	'ui.press': { args: 'event', result: VOID },
	'cart.quantity-select': { args: [anyOf(num, str), str], result: VOID },
	'filters.value': { args: [str], result: VOID },
	'filters.search': { args: [str], result: VOID },
	'shell.cart-toggle': { args: [], result: ACTION_RESULT },
	'shell.login': { args: [], result: ACTION_RESULT },
	'shell.logout': { args: [], result: ACTION_RESULT },
	'shell.account': { args: [], result: ACTION_RESULT },
	'home.subscribe': { args: [str, str], result: FORM_RESULT },
	'contact.submit': { args: [str, str, str, str, str], result: FORM_RESULT },
	'loyalty.redeem-toggle': { args: [bool], result: ACTION_RESULT },
	'pdp.waitlist-join': { args: [str], result: ACTION_RESULT },
} as const satisfies Record<string, ActionSpec>;

export type ActionName = keyof typeof ACTIONS;

type InferArgs<T> = T extends readonly Schema[] ? { -readonly [I in keyof T]: Infer<T[I]> } : [];
type ArgsOf<N extends ActionName> = InferArgs<(typeof ACTIONS)[N]['args']>;
type ResultOf<N extends ActionName> = Infer<(typeof ACTIONS)[N]['result']>;

/** What the platform function behind an action may be: for a void action anything (the result is discarded), else its result type. */
export type ActionImpl<N extends ActionName> = QRL<(...args: ArgsOf<N>) => ResultOf<N> extends void ? unknown : ResultOf<N> | Promise<ResultOf<N>>>;

/** What presentation code calls: the gateway's wrapper around a platform action. */
export type BoundAction<N extends ActionName> = QRL<(...args: ArgsOf<N>) => Promise<ResultOf<N> | ActionFailure>>;

export interface ActionHandle<N extends ActionName = ActionName> {
	readonly kind: 'sr-action';
	readonly name: N;
	readonly run: QRL<(...args: never[]) => unknown>;
}

const isQrl = (v: unknown): boolean => typeof v === 'function' && typeof (v as { getSymbol?: unknown }).getSymbol === 'function';

/** The only way to approve a platform function as an action presentation code may call. */
export function platformAction<N extends ActionName>(name: N, run: ActionImpl<N>): ActionHandle<N> {
	if (!Object.prototype.hasOwnProperty.call(ACTIONS, name)) throw new GatewayError(String(name), 'not a platform action');
	if (!isQrl(run)) throw new GatewayError(name, 'a platform action runs a QRL');
	return Object.freeze({ kind: 'sr-action', name, run: run as unknown as ActionHandle<N>['run'] });
}

/** The handle a caller passed for `path`, checked: exact shape, a name this prop allows, a QRL. A bare QRL or a forged object fails. */
export function checkHandle(value: unknown, allowed: readonly ActionName[], path: string): ActionHandle {
	if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new GatewayError(path, isQrl(value) ? 'a bare QRL is not a platform action (use platformAction)' : 'expected a platform action');
	}
	const keys = Reflect.ownKeys(value).map(String).sort();
	if (keys.join() !== 'kind,name,run') throw new GatewayError(path, 'expected a platform action');
	for (const k of keys) {
		const d = Object.getOwnPropertyDescriptor(value, k);
		if (!d || d.get || d.set) throw new GatewayError(path, 'expected a platform action');
	}
	const h = value as ActionHandle;
	if (h.kind !== 'sr-action' || !isQrl(h.run)) throw new GatewayError(path, 'expected a platform action');
	if (!allowed.includes(h.name)) throw new GatewayError(path, `action '${String(h.name)}' is not allowed here (allowed: ${allowed.join(', ')})`);
	return h;
}

/** Runs a platform action for presentation code: arguments checked, the result (awaited) rebuilt from the action's result schema. */
export async function invokeAction(name: ActionName, run: QRL<(...args: never[]) => unknown>, args: readonly unknown[]): Promise<unknown> {
	const spec: ActionSpec = ACTIONS[name];
	let callArgs: unknown[] = [];
	if (spec.args !== 'event') {
		if (args.length > spec.args.length) throw new GatewayError(`${name}(…)`, `expected ${spec.args.length} argument(s), got ${args.length}`);
		callArgs = spec.args.map((s, i) => detachValue(s, args[i], `${name} argument ${i + 1}`));
	}
	let value: unknown;
	try {
		value = await (run as unknown as (...a: unknown[]) => unknown)(...callArgs);
	} catch {
		// Whatever the platform function threw or rejected with (a live array, an Error whose `cause` holds state) stays here: presentation
		// gets a new fixed-shape failure, never the original value, its message, or its cause.
		return actionFailure(name);
	}
	return detachValue(spec.result, value, `${name} result`);
}

/** What presentation code receives when a platform action throws or rejects. Built here, from constants. */
export interface ActionFailure {
	readonly ok: false;
	readonly code: 'action-failed';
	readonly message: string;
}

function actionFailure(name: ActionName): ActionFailure {
	return Object.freeze({ ok: false, code: 'action-failed', message: `Action '${name}' failed.` });
}
