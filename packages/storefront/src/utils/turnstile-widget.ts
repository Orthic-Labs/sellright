/**
 * Shared Cloudflare Turnstile loader for client-side forms (order tracking,
 * newsletter). Mirrors the contact/login widgets: explicit render, one script
 * tag per document, no-op when the site key is not configured.
 */
export const TURNSTILE_SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

const SCRIPT_SELECTOR = 'script[src*="challenges.cloudflare.com/turnstile"]';

/** Render a Turnstile widget into `#containerId`, calling `onToken` with the
 *  solved token and `onExpire` when it expires or errors. Idempotent. */
export function mountTurnstile(containerId: string, onToken: (token: string) => void, onExpire: () => void): void {
	if (!TURNSTILE_SITE_KEY || typeof window === 'undefined') return;
	const render = () => {
		const el = document.getElementById(containerId);
		const ts = (window as any).turnstile;
		if (!el || !ts || el.childElementCount > 0) return;
		ts.render(el, {
			sitekey: TURNSTILE_SITE_KEY,
			theme: 'light',
			callback: (token: string) => onToken(token),
			'expired-callback': () => onExpire(),
			'error-callback': () => onExpire(),
		});
	};
	if ((window as any).turnstile) return render();
	const existing = document.querySelector(SCRIPT_SELECTOR);
	if (existing) {
		existing.addEventListener('load', render);
		return;
	}
	const script = document.createElement('script');
	script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
	script.async = true;
	script.addEventListener('load', render);
	document.head.appendChild(script);
}

/** Tokens are single-use: reset the (only) widget after a submit attempt. */
export function resetTurnstile(): void {
	try {
		(window as any).turnstile?.reset?.();
	} catch {
		// widget not rendered — nothing to reset
	}
}
