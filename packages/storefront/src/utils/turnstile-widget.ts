/**
 * Shared Cloudflare Turnstile loader for client-side forms (order tracking,
 * newsletter). Mirrors the contact/login widgets: explicit render, one script
 * tag per document, no-op when the site key is not configured.
 */
export const TURNSTILE_SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

const SCRIPT_SELECTOR = 'script[src*="challenges.cloudflare.com/turnstile"]';

/** Render a Turnstile widget into `#containerId`, calling `onToken` with the
 *  solved token and `onExpire` when it expires or errors. Idempotent. */
export function mountTurnstile(containerId: string, onToken: (token: string) => void, onExpire: () => void, onMount?: (widgetId: string) => void): () => void {
	if (!TURNSTILE_SITE_KEY || typeof window === 'undefined') return () => {};
	let disposed = false;
	let widgetId: string | undefined;
	let watchedScript: HTMLScriptElement | null = null;
	const cleanup = () => {
		disposed = true;
		watchedScript?.removeEventListener('load', render);
		if (widgetId !== undefined) {
			try { (window as any).turnstile?.remove?.(widgetId); } catch { /* already removed */ }
		}
	};
	const render = () => {
		const el = document.getElementById(containerId);
		const ts = (window as any).turnstile;
		if (disposed || !el || !ts || el.childElementCount > 0) return;
		widgetId = ts.render(el, {
			sitekey: TURNSTILE_SITE_KEY,
			theme: 'light',
			// Hidden unless Cloudflare needs the shopper to interact.
			appearance: 'interaction-only',
			callback: (token: string) => { if (!disposed) onToken(token); },
			'expired-callback': () => { if (!disposed) onExpire(); },
			'error-callback': () => { if (!disposed) onExpire(); },
		});
		if (widgetId !== undefined) onMount?.(widgetId);
	};
	if ((window as any).turnstile) { render(); return cleanup; }
	const existing = document.querySelector(SCRIPT_SELECTOR);
	if (existing) {
		watchedScript = existing as HTMLScriptElement;
		existing.addEventListener('load', render);
		return cleanup;
	}
	const script = document.createElement('script');
	script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
	script.async = true;
	watchedScript = script;
	script.addEventListener('load', render);
	document.head.appendChild(script);
	return cleanup;
}

/** Tokens are single-use: reset a specific widget, or preserve legacy default-widget behavior. */
export function resetTurnstile(widgetId?: string): void {
	try {
		const ts = (window as any).turnstile;
		if (widgetId === undefined) ts?.reset?.();
		else ts?.reset?.(widgetId);
	} catch {
		// widget not rendered — nothing to reset
	}
}

const INTENT_EVENTS = ['focusin', 'pointerdown', 'input', 'touchstart'] as const;

/** The part of the page that shows intent to use the form `#containerId` belongs to: its <form>, else the nearest ancestor
 *  holding a text field (brand views place the field beside the container, not always in a <form>). */
export function turnstileIntentRegion(container: Element): Element | null {
	const form = container.closest('form');
	if (form) return form;
	for (let el = container.parentElement; el; el = el.parentElement) {
		if (el === document.body || el === document.documentElement) return null;
		if (el.querySelector('input, textarea')) return el;
	}
	return null;
}

/** P7/V34: mount Turnstile only on intent — the first focus, pointer, touch or input inside the form `#containerId`
 *  belongs to — instead of when the page becomes visible. Listens on the document so a container rendered later still
 *  works. Returns a cleanup that removes the listeners and, once mounted, the widget. No-op without a site key. */
export function mountTurnstileOnIntent(containerId: string, onToken: (token: string) => void, onExpire: () => void, onMount?: (widgetId: string) => void): () => void {
	if (!TURNSTILE_SITE_KEY || typeof window === 'undefined') return () => {};
	let unmount: (() => void) | null = null;
	let disposed = false;
	const stop = () => { for (const ev of INTENT_EVENTS) document.removeEventListener(ev, onIntent, true); };
	function onIntent(ev: Event) {
		if (disposed || unmount) return;
		const container = document.getElementById(containerId);
		const target = ev.target as Node | null;
		if (!container || !target) return;
		const region = turnstileIntentRegion(container) ?? container;
		if (!region.contains(target)) return;
		stop();
		unmount = mountTurnstile(containerId, onToken, onExpire, onMount);
	}
	for (const ev of INTENT_EVENTS) document.addEventListener(ev, onIntent, { capture: true, passive: true });
	return () => {
		disposed = true;
		stop();
		unmount?.();
	};
}
