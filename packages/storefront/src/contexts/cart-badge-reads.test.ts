/**
 * #LCP: the header's computed badge (shell.tsx BrandHeaderMount, header.tsx) subscribes to whatever cartBadgeCount reads. With no
 * persisted count it must not read `hasLoadedOnce`, so the boot's hasLoadedOnce flip does not re-run the header (and load its
 * slot runtime) before the first paint. The returned count is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
// CartContext.tsx is a Qwik module: without the optimizer `$()` throws, so the QRL wrappers become plain functions here.
vi.mock('@qwik.dev/core', () => ({
	$: <T>(fn: T) => fn,
	component$: <T>(fn: T) => fn,
	createContextId: (id: string) => ({ id }),
	useContext: () => undefined,
	useContextProvider: () => undefined,
	useStore: <T>(v: T) => v,
	useOnDocument: () => undefined,
	Slot: () => null,
}));
import { cartBadgeCount } from './CartContext';

type BadgeState = Parameters<typeof cartBadgeCount>[0];

function recordReads(state: BadgeState): { proxy: BadgeState; reads: Set<string> } {
	const reads = new Set<string>();
	const proxy = new Proxy(state, { get(t, p, r) { if (typeof p === 'string') reads.add(p); return Reflect.get(t, p, r); } });
	return { proxy, reads };
}

const lines = (...q: number[]) => q.map((quantity) => ({ quantity }));

describe('cartBadgeCount reads', () => {
	it('no persisted count: never reads hasLoadedOnce (the header does not subscribe to the boot flip)', () => {
		for (const hasLoadedOnce of [false, true]) {
			const { proxy, reads } = recordReads({ hasLoadedOnce, lastKnownQuantity: null, cart: { lines: [] } });
			expect(cartBadgeCount(proxy)).toBe(0);
			expect(reads.has('hasLoadedOnce')).toBe(false);
		}
	});

	it('same counts as before for every state', () => {
		expect(cartBadgeCount({ hasLoadedOnce: false, lastKnownQuantity: 3, cart: { lines: lines(1) } })).toBe(3);
		expect(cartBadgeCount({ hasLoadedOnce: true, lastKnownQuantity: 3, cart: { lines: lines(1, 2) } })).toBe(3);
		expect(cartBadgeCount({ hasLoadedOnce: true, lastKnownQuantity: 5, cart: { lines: lines(1) } })).toBe(1);
		expect(cartBadgeCount({ hasLoadedOnce: false, lastKnownQuantity: null, cart: { lines: lines(2, 2) } })).toBe(4);
		expect(cartBadgeCount({ hasLoadedOnce: false, lastKnownQuantity: 0, cart: { lines: lines(2) } })).toBe(0);
	});
});
