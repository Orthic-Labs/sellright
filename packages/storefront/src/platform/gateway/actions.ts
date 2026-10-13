// Brand views gateway (plan §1, §3): the action half of the L1 → presentation boundary. Presentation code receives only actions the
// platform created with `platformAction(name, qrl)`, from the fixed list below. The gateway re-wraps each one (gate.tsx `bindAction`),
// so the arguments presentation passes and every result it gets back, synchronous or asynchronous, go through the action's fixed
// schemas: a result is a new detached value, never the platform's own object. A handle is a plain serialisable object holding a QRL,
// so it survives SSR and resumption without any in-memory registry; `gateway-action-literal` (scripts/check-gateway.mjs) keeps this
// file its only constructor.
import type { QRL } from '@qwik.dev/core';
import { GatewayError, VOID, anyOf, bool, detachValue, lit, nul, num, obj, str, type Infer, type Schema } from './schema';

export const ACTION_RESULT = anyOf(obj({ ok: lit(true) }), obj({ ok: lit(false), reason: lit('invalid', 'busy', 'disposed', 'error') }));
export const FORM_RESULT = anyOf(obj({ ok: lit(true) }), obj({ ok: lit(false), reason: lit('invalid', 'busy', 'turnstile', 'server', 'disposed') }));
/**
 * The outcome of a configurator add (brand views PR2 plan §5), built only from the add's own server response: `added` (the line is
 * available), `added-unavailable` (the server appended the units but its live line says they cannot all be bought: the drawer flags the
 * line and checkout blocks it), or `rejected` with nothing added.
 */
export const ADD_RESULT = anyOf(
	obj({ status: lit('added'), sku: str, quantity: num, lineQuantity: num }),
	obj({ status: lit('added-unavailable'), sku: str, quantity: num, lineQuantity: num, availableQuantity: nul(num) }),
	obj({ status: lit('rejected'), reason: lit('invalid', 'not-eligible', 'busy', 'disposed', 'cart-changed', 'cart-error', 'error'), message: nul(str) }),
);

interface ActionSpec {
	/** 'event': a DOM handler; the framework-delivered arguments are not forwarded. Otherwise one schema per argument. */
	readonly args: 'event' | readonly Schema[];
	readonly result: Schema;
	/** What presentation gets when the platform function throws or rejects: a member of `result` (void: nothing). */
	readonly failure?: { readonly ok: false; readonly reason: string } | { readonly status: 'rejected'; readonly reason: string; readonly message: null };
}

const ACTION_FAILED = { ok: false, reason: 'error' } as const satisfies Infer<typeof ACTION_RESULT>;
const FORM_FAILED = { ok: false, reason: 'server' } as const satisfies Infer<typeof FORM_RESULT>;
const ADD_FAILED = { status: 'rejected', reason: 'error', message: null } as const satisfies Infer<typeof ADD_RESULT>;

/** Every action presentation code can be given. Adding one is a reviewed platform change. */
export const ACTIONS = {
	'ui.press': { args: 'event', result: VOID },
	'cart.quantity-select': { args: [anyOf(num, str), str], result: VOID },
	'filters.value': { args: [str], result: VOID },
	'filters.search': { args: [str], result: VOID },
	'shell.cart-toggle': { args: [], result: ACTION_RESULT, failure: ACTION_FAILED },
	'shell.login': { args: [], result: ACTION_RESULT, failure: ACTION_FAILED },
	'shell.logout': { args: [], result: ACTION_RESULT, failure: ACTION_FAILED },
	'shell.account': { args: [], result: ACTION_RESULT, failure: ACTION_FAILED },
	'home.subscribe': { args: [str, str], result: FORM_RESULT, failure: FORM_FAILED },
	'contact.submit': { args: [str, str, str, str, str], result: FORM_RESULT, failure: FORM_FAILED },
	'loyalty.redeem-toggle': { args: [bool], result: ACTION_RESULT, failure: ACTION_FAILED },
	'pdp.waitlist-join': { args: [str], result: ACTION_RESULT, failure: ACTION_FAILED },
	// Brand views PR2 (shop and product views). Selection never reads stock; only `retry-stock` starts a live read (after an error).
	'configurator.product-select': { args: [str], result: ACTION_RESULT, failure: ACTION_FAILED },
	'configurator.option-select': { args: [str, nul(str)], result: ACTION_RESULT, failure: ACTION_FAILED },
	'configurator.quantity': { args: [num], result: ACTION_RESULT, failure: ACTION_FAILED },
	'configurator.consent': { args: [bool], result: ACTION_RESULT, failure: ACTION_FAILED },
	'configurator.retry-stock': { args: [], result: ACTION_RESULT, failure: ACTION_FAILED },
	'configurator.add': { args: [], result: ADD_RESULT, failure: ADD_FAILED },
	'shop.in-stock': { args: [bool], result: ACTION_RESULT, failure: ACTION_FAILED },
} as const satisfies Record<string, ActionSpec>;

export type ActionName = keyof typeof ACTIONS;

type InferArgs<T> = T extends readonly Schema[] ? { -readonly [I in keyof T]: Infer<T[I]> } : [];
type ArgsOf<N extends ActionName> = InferArgs<(typeof ACTIONS)[N]['args']>;
type ResultOf<N extends ActionName> = Infer<(typeof ACTIONS)[N]['result']>;

/** What the platform function behind an action may be: for a void action anything (the result is discarded), else its result type. */
export type ActionImpl<N extends ActionName> = QRL<(...args: ArgsOf<N>) => ResultOf<N> extends void ? unknown : ResultOf<N> | Promise<ResultOf<N>>>;

/** What presentation code calls: the gateway's wrapper around a platform action. */
export type BoundAction<N extends ActionName> = QRL<(...args: ArgsOf<N>) => Promise<ResultOf<N>>>;

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
		// gets the action's own failure result from its public contract (`reason`), never the original value, its message, or its cause.
		return spec.failure ? Object.freeze({ ...spec.failure }) : undefined;
	}
	return detachValue(spec.result, value, `${name} result`);
}
