// #425: the checkout prerender (Speculation Rules) and the rule every prerendered document follows.
//
// A prerendered /checkout/ is a real page load in a hidden tab: its HTML is fetched, its scripts run and its components hydrate BEFORE the
// shopper taps Checkout (the tap then "activates" it). Two consequences are handled here and at the few call sites that use this module:
//
//  1. Arming: the rules are inserted only while the drawer is open AND the cart exists on the server and has not changed since (the page
//     the browser built shows that cart). Any change removes the rules, so the stale prerender is discarded, and re-inserts them for the new
//     state after a short pause (a removal and an insertion in the same task are merged by the browser into "no change", which would keep
//     the stale page).
//  2. Waiting: a prerendered document must not do what a visit does until it is shown. LOCKED stock rule: the checkout entry's live
//     cart/stock read is the check at ENTRY; it must run at activation, not seconds earlier in the hidden tab. So every API request of a
//     prerendered document (the SellRight client's `ready` hook), the cart lock (CartService.exclusive: a hidden page must never hold the
//     origin-wide cart lock) and the third-party payment / analytics starts wait for `prerenderingchange`. Nothing is read, cached or kept
//     from the prerendered state: after activation the page behaves as a fresh load, minus the time its HTML and scripts took.
//
// The checkout document is `private, no-store` HTML. That does not stop a prerender (it is a navigation in a hidden tab, and the response
// is used once, by that navigation); it only rules out `<link rel=prefetch>` as a fallback, which would need a cacheable response. Browsers
// without Speculation Rules therefore get nothing here: the tap is the ordinary full document load.

type PrerenderDocument = Document & { prerendering?: boolean };

/** This document is being prerendered (not yet shown to the shopper). */
export const isPrerendering = (): boolean => typeof document !== 'undefined' && (document as PrerenderDocument).prerendering === true;

/** Resolves when this document is activated (at once when it is not prerendering). */
export function whenActivated(): Promise<void> {
	if (!isPrerendering()) return Promise.resolve();
	return new Promise<void>((resolve) => document.addEventListener('prerenderingchange', () => resolve(), { once: true }));
}

/** A promise to wait for while prerendering, undefined otherwise (no extra tick on the normal path). */
export const activationGate = (): Promise<void> | undefined => (isPrerendering() ? whenActivated() : undefined);

/** The page the drawer's Checkout control opens. */
export const CHECKOUT_PRERENDER_URL = '/checkout/';

/** The Speculation Rules JSON for the checkout: the ONE text the page inserts and the CSP hashes. */
export const CHECKOUT_RULES_TEXT = '{"prerender":[{"source":"list","urls":["/checkout/"],"eagerness":"immediate"}]}';

/** base64 sha256 of CHECKOUT_RULES_TEXT. script-src carries it as 'sha256-...' on every render: Chrome ignores 'inline-speculation-rules'
 *  once a policy has hashes (shell renders) or a nonce, exactly as it ignores 'unsafe-inline'. A test pins it to the text. */
export const CHECKOUT_RULES_SHA256 = 'MnazFGrTDvWjs8L+6BgP0Xl4pYOqeN6SJdkY/YDPjJE=';

/** The browser accepts inline speculation rules. */
export function supportsSpeculationRules(): boolean {
	try {
		return typeof HTMLScriptElement !== 'undefined' && typeof HTMLScriptElement.supports === 'function' && HTMLScriptElement.supports('speculationrules');
	} catch {
		return false;
	}
}

const RULES_ID = 'sr-checkout-prerender';
/** How long a removal is given to take effect before the rules are inserted again. */
export const REARM_DELAY_MS = 150;
/** The first arming waits this long after the cart settled: a prerender is a whole page load (HTML, scripts) and must not compete for
 *  the connection with the drawer's own last requests (its shipping quote) on a slow phone. */
export const FIRST_ARM_DELAY_MS = 800;

let armedKey: string | null = null;
let pendingKey: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function removeRules(): boolean {
	const el = typeof document === 'undefined' ? null : document.getElementById(RULES_ID);
	if (!el) return false;
	el.remove();
	return true;
}

function insertRules(): void {
	const script = document.createElement('script');
	script.type = 'speculationrules';
	script.id = RULES_ID;
	script.textContent = CHECKOUT_RULES_TEXT;
	document.head.appendChild(script);
}

/**
 * Keep the checkout prerender in step with the cart. `key` identifies the exact cart state the prerendered checkout would show (null:
 * must not be prerendered: no server cart yet, a change in flight, drawer closed). The same key again keeps the prerender; a new key
 * discards it and prerenders anew; null discards it. No-op without Speculation Rules support.
 */
/** #425: off unless the build sets VITE_CHECKOUT_PRERENDER=1. Measured live on Damned (2026-11-04, m375): with the prerender armed,
 *  tap Checkout -> total visible went 729 -> 1300 ms (median of 5) and every tap still did a full load, so it ships disabled until
 *  it is shown to help. */
export const checkoutPrerenderEnabled = (): boolean => import.meta.env.VITE_CHECKOUT_PRERENDER === '1';

export function syncCheckoutPrerender(key: string | null): void {
	if (!checkoutPrerenderEnabled()) return;
	if (typeof document === 'undefined' || !supportsSpeculationRules()) return;
	if (key === null) {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		pendingKey = null;
		armedKey = null;
		removeRules();
		return;
	}
	if (key === armedKey || key === pendingKey) return;
	if (timer !== undefined) clearTimeout(timer);
	timer = undefined;
	armedKey = null;
	const hadRules = removeRules() || pendingKey !== null; // replacing a state: the short pause
	pendingKey = key;
	timer = setTimeout(() => {
		timer = undefined;
		if (pendingKey !== key) return;
		pendingKey = null;
		insertRules();
		armedKey = key;
	}, hadRules ? REARM_DELAY_MS : FIRST_ARM_DELAY_MS);
}

/** The key the rules are armed (or about to be re-armed) for, or null. */
export const armedCheckoutKey = (): string | null => armedKey ?? pendingKey;

/** Test seam: forget what is armed. */
export function resetCheckoutPrerenderForTest(): void {
	if (timer !== undefined) clearTimeout(timer);
	timer = undefined;
	armedKey = null;
	pendingKey = null;
}
