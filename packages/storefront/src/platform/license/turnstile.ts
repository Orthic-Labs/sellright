// Cloudflare Turnstile for the license account pages. Tokens are single-use: every submit is followed by a fresh render.
// The public site key is VITE_TURNSTILE_SITE_KEY (the CSP admits challenges.cloudflare.com only when it is set).
type TurnstileApi = {
	render: (container: HTMLElement, opts: Record<string, unknown>) => string | undefined;
	remove?: (widgetId: string) => void;
};

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export const TURNSTILE_SITE_KEY: string = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) || '';

const api = (): TurnstileApi | undefined =>
	typeof window !== 'undefined' ? (window as unknown as { turnstile?: TurnstileApi }).turnstile : undefined;

let scriptPromise: Promise<void> | undefined;

/** Loads api.js once. Rejects when the script fails (blocked, offline). */
export function loadTurnstile(): Promise<void> {
	if (api()) return Promise.resolve();
	if (!scriptPromise) {
		scriptPromise = new Promise<void>((resolve, reject) => {
			const s = document.createElement('script');
			s.src = SCRIPT_SRC;
			s.async = true;
			s.onload = () => (api() ? resolve() : reject(new Error('turnstile api missing')));
			s.onerror = () => {
				scriptPromise = undefined;
				s.remove();
				reject(new Error('turnstile script failed'));
			};
			document.head.appendChild(s);
		});
	}
	return scriptPromise;
}

/** Renders (or re-renders) the widget into `containerId`; '' when the container is gone or Turnstile is absent. */
export function renderTurnstile(containerId: string, onToken: (token: string) => void, onError: () => void, previousWidgetId?: string): string {
	const t = api();
	const container = typeof document !== 'undefined' ? document.getElementById(containerId) : null;
	if (!t || !container || !TURNSTILE_SITE_KEY) return '';
	if (previousWidgetId) {
		try { t.remove?.(previousWidgetId); } catch { /* already gone with its view */ }
	}
	container.innerHTML = '';
	return t.render(container, {
		sitekey: TURNSTILE_SITE_KEY,
		theme: 'light',
		callback: (token: string) => onToken(token),
		'expired-callback': () => onToken(''),
		'error-callback': () => { onToken(''); onError(); },
	}) ?? '';
}
