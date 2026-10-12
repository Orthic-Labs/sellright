/**
 * Phantom marker for live state the base owns (r14, scripts/check-l2-boundary.mjs).
 *
 * A type that carries `Live` is mutable runtime state: the cart store and its lines, app state and its addresses, the checkout
 * contexts, the signed-in customer's account objects. The marker exists only in the type system (optional, never set, no runtime
 * value), so assignment and literals are unaffected. The L2-boundary check resolves the checker's type of every JSX attribute
 * handed to an ejectable component and rejects any type that reaches the marker, so a getter, a helper, a wrapper, a callback
 * parameter or a spread cannot launder a live object: the type follows it. `Detached<T>` is the only way to take the marker off,
 * and only `project*()` functions (which copy field by field) return it.
 *
 * Import with `import type`: `LIVE` is a declaration only and has no runtime value.
 */
export declare const LIVE: unique symbol;

export interface Live {
	readonly [LIVE]?: true;
}

/** `T` without the live marker. Return this only from a function that builds a detached copy. */
export type Detached<T> = T extends Live ? Omit<T, typeof LIVE> : T;
