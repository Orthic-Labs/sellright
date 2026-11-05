// P7/V15: the defined trigger for an optional third-party SDK (Stripe wallets / pay-later messaging). It resolves after the
// page has finished loading and the browser is idle, or earlier on the shopper's first interaction — never during the
// critical load. Client only; on the server (no window) it resolves at once so callers need no guard.

const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;

export interface IdleTriggerOptions {
	/** requestIdleCallback timeout once the page has loaded (ms). */
	idleTimeoutMs?: number;
	/** Upper bound from the call, so a never-finishing load (a stalled image) cannot hide the element forever (ms). */
	maxWaitMs?: number;
}

/** Resolves on (window load + idle) OR the first pointer/key/touch/scroll interaction OR `maxWaitMs`, whichever is first. */
export function afterLoadIdleOrInteraction(opts: IdleTriggerOptions = {}): Promise<void> {
	if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve();
	const idleTimeoutMs = opts.idleTimeoutMs ?? 2000;
	const maxWaitMs = opts.maxWaitMs ?? 8000;
	return new Promise<void>((resolve) => {
		let done = false;
		const timers: number[] = [];
		const finish = () => {
			if (done) return;
			done = true;
			for (const ev of INTERACTION_EVENTS) window.removeEventListener(ev, finish, true);
			window.removeEventListener('load', onLoad);
			for (const t of timers) clearTimeout(t);
			resolve();
		};
		const idle = () => {
			const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
			if (typeof ric === 'function') ric(finish, { timeout: idleTimeoutMs });
			else timers.push(window.setTimeout(finish, 200));
		};
		const onLoad = () => idle();
		for (const ev of INTERACTION_EVENTS) window.addEventListener(ev, finish, { capture: true, passive: true, once: true });
		timers.push(window.setTimeout(finish, maxWaitMs));
		if (document.readyState === 'complete') idle();
		else window.addEventListener('load', onLoad, { once: true });
	});
}

/** PDP variant: resolves ONLY on the first pointer/key/touch/scroll interaction — never on load, idle or a timer, so an
 *  unattended page (a Lighthouse run) never fetches the SDK. Never resolves on the server. */
export function afterInteraction(): Promise<void> {
	if (typeof window === 'undefined' || typeof document === 'undefined') return new Promise<void>(() => {});
	return new Promise<void>((resolve) => {
		const finish = () => {
			for (const ev of INTERACTION_EVENTS) window.removeEventListener(ev, finish, true);
			resolve();
		};
		for (const ev of INTERACTION_EVENTS) window.addEventListener(ev, finish, { capture: true, passive: true, once: true });
	});
}
