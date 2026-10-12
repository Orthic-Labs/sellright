/**
 * Phantom marker for live state the base owns (diagnostics only).
 *
 * A type that carries `Live` is mutable runtime state: the cart store and its lines, app state and its addresses, the checkout
 * contexts, the signed-in customer's account objects. The marker exists only in the type system (optional, never set, no runtime
 * value), so assignment and literals are unaffected. scripts/check-l2-boundary.mjs uses it for an ADVISORY call-site diagnostic.
 *
 * It is not the boundary. Presentation code never receives a live reference because L1 reaches presentation only through the
 * gateway (src/platform/gateway; scripts/check-gateway.mjs), which rebuilds every data prop from a fixed schema and every action result
 * the same way (docs/plans/2026-10-11-brand-views-gateway.md). `Detached<T>` documents that a `project*()` function returns a copy.
 *
 * Import with `import type`: `LIVE` is a declaration only and has no runtime value.
 */
export declare const LIVE: unique symbol;

export interface Live {
	readonly [LIVE]?: true;
}

/** `T` without the live marker. Return this only from a function that builds a detached copy. */
export type Detached<T> = T extends Live ? Omit<T, typeof LIVE> : T;
