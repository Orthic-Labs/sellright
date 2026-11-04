import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FIRST_ARM_DELAY_MS, REARM_DELAY_MS, activationGate, armedCheckoutKey, CHECKOUT_RULES_TEXT, CHECKOUT_RULES_SHA256, isPrerendering, resetCheckoutPrerenderForTest, supportsSpeculationRules, syncCheckoutPrerender, whenActivated,
} from './prerender';

// A tiny fake of the document the module touches: head children by id, a listener list, and the prerendering flag.
function fakeDocument() {
	const head: { id: string; textContent: string; type: string; remove(): void }[] = [];
	const listeners: Array<() => void> = [];
	const doc = {
		prerendering: false,
		head: { appendChild: (el: (typeof head)[number]) => { head.push(el); return el; } },
		createElement: () => {
			const el = { id: '', textContent: '', type: '', remove() { const i = head.indexOf(el); if (i >= 0) head.splice(i, 1); } };
			return el;
		},
		getElementById: (id: string) => head.find((e) => e.id === id) ?? null,
		addEventListener: (_: string, cb: () => void) => { listeners.push(cb); },
	};
	return { doc, head, activate: () => { doc.prerendering = false; listeners.splice(0).forEach((cb) => cb()); } };
}

describe('prerender activation', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('a normal document is never held', async () => {
		const { doc } = fakeDocument();
		vi.stubGlobal('document', doc);
		expect(isPrerendering()).toBe(false);
		expect(activationGate()).toBeUndefined();
		await whenActivated();
	});

	it('a prerendering document waits for prerenderingchange, once', async () => {
		const { doc, activate } = fakeDocument();
		doc.prerendering = true;
		vi.stubGlobal('document', doc);
		expect(isPrerendering()).toBe(true);
		let done = false;
		const gate = activationGate()!;
		void gate.then(() => { done = true; });
		await Promise.resolve();
		expect(done).toBe(false);
		activate();
		await gate;
		expect(done).toBe(true);
		expect(activationGate()).toBeUndefined();
	});
});

describe('checkout speculation rules', () => {
	it('prerender exactly /checkout/ from a list, immediately', () => {
		expect(JSON.parse(CHECKOUT_RULES_TEXT)).toEqual({ prerender: [{ source: 'list', urls: ['/checkout/'], eagerness: 'immediate' }] });
	});
	it('the CSP hash is the sha256 of exactly that text', async () => {
		const { createHash } = await import('node:crypto');
		expect(CHECKOUT_RULES_SHA256).toBe(createHash('sha256').update(CHECKOUT_RULES_TEXT, 'utf8').digest('base64'));
	});
});

describe('syncCheckoutPrerender', () => {
	let env: ReturnType<typeof fakeDocument>;
	beforeEach(() => {
		vi.useFakeTimers();
		env = fakeDocument();
		vi.stubGlobal('document', env.doc);
		vi.stubGlobal('HTMLScriptElement', { supports: (t: string) => t === 'speculationrules' });
		resetCheckoutPrerenderForTest();
	});
	afterEach(() => { resetCheckoutPrerenderForTest(); vi.useRealTimers(); vi.unstubAllGlobals(); });

	const rules = () => env.head.filter((e) => e.id === 'sr-checkout-prerender');

	it('feature-detects: no support, no script', () => {
		vi.stubGlobal('HTMLScriptElement', {});
		expect(supportsSpeculationRules()).toBe(false);
		syncCheckoutPrerender('t|1');
		expect(rules()).toHaveLength(0);
	});

	it('arms once for a cart state (after the first-arm pause) and keeps it while the state is unchanged', () => {
		syncCheckoutPrerender('t|1');
		expect(rules()).toHaveLength(0);
		vi.advanceTimersByTime(FIRST_ARM_DELAY_MS);
		expect(rules()).toHaveLength(1);
		expect(rules()[0].type).toBe('speculationrules');
		expect(rules()[0].textContent).toBe(CHECKOUT_RULES_TEXT); // byte-identical to what the CSP hashes
		const first = rules()[0];
		syncCheckoutPrerender('t|1');
		expect(rules()).toHaveLength(1);
		expect(rules()[0]).toBe(first);
	});

	it('a changed cart removes the rules at once and re-arms for the new state after the pause (a stale prerender is discarded)', () => {
		syncCheckoutPrerender('t|1');
		vi.advanceTimersByTime(FIRST_ARM_DELAY_MS);
		syncCheckoutPrerender('t|2');
		expect(rules()).toHaveLength(0); // removed; not yet re-inserted
		vi.advanceTimersByTime(REARM_DELAY_MS - 1);
		expect(rules()).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(rules()).toHaveLength(1);
	});

	it('null (no server cart, a write in flight, drawer closed) removes the rules and cancels a pending arm', () => {
		syncCheckoutPrerender('t|1');
		vi.advanceTimersByTime(FIRST_ARM_DELAY_MS);
		syncCheckoutPrerender('t|2');
		syncCheckoutPrerender(null);
		vi.advanceTimersByTime(FIRST_ARM_DELAY_MS * 2);
		expect(rules()).toHaveLength(0);
	});

	it('the same key again while the first arming is pending does not restart the pause', () => {
		syncCheckoutPrerender('t|1');
		vi.advanceTimersByTime(FIRST_ARM_DELAY_MS - 1);
		syncCheckoutPrerender('t|1');
		vi.advanceTimersByTime(1);
		expect(rules()).toHaveLength(1);
	});

	it('exposes the key it is armed (or about to be armed) for', () => {
		expect(armedCheckoutKey()).toBeNull();
		syncCheckoutPrerender('k1');
		expect(armedCheckoutKey()).toBe('k1');
		syncCheckoutPrerender(null);
		expect(armedCheckoutKey()).toBeNull();
	});

	it('a newer state during the pause wins; only one script is ever left', () => {
		syncCheckoutPrerender('t|1');
		vi.advanceTimersByTime(FIRST_ARM_DELAY_MS);
		syncCheckoutPrerender('t|2');
		syncCheckoutPrerender('t|3');
		vi.advanceTimersByTime(REARM_DELAY_MS * 3);
		expect(rules()).toHaveLength(1);
	});
});
