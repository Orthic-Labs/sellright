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
