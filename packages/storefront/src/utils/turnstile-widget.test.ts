import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); document.body.innerHTML = ''; document.querySelectorAll('script[src*="challenges.cloudflare.com/turnstile"]').forEach((el) => el.remove()); });

describe('scoped Turnstile lifecycle', () => {
	it('resets/removes only requested widget & ignores callbacks after cleanup', async () => {
		vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key');
		document.body.innerHTML = '<div id="restock-security"></div>';
		const render = vi.fn((_container: Element, _options: unknown) => 'restock-widget');
		const reset = vi.fn();
		const remove = vi.fn();
		vi.stubGlobal('turnstile', { render, reset, remove });
		const { mountTurnstile, resetTurnstile } = await import('./turnstile-widget');
		const onToken = vi.fn();
		const onExpire = vi.fn();
		const onMount = vi.fn();
		const cleanup = mountTurnstile('restock-security', onToken, onExpire, onMount);
		expect(onMount).toHaveBeenCalledWith('restock-widget');
		const callbacks = render.mock.calls[0][1] as { callback(token: string): void; 'expired-callback'(): void };
		callbacks.callback('fresh');
		expect(onToken).toHaveBeenCalledWith('fresh');
		resetTurnstile('restock-widget');
		expect(reset).toHaveBeenLastCalledWith('restock-widget');
		resetTurnstile();
		expect(reset).toHaveBeenLastCalledWith();
		cleanup();
		expect(remove).toHaveBeenCalledExactlyOnceWith('restock-widget');
		callbacks.callback('late');
		callbacks['expired-callback']();
		expect(onToken).toHaveBeenCalledTimes(1);
		expect(onExpire).not.toHaveBeenCalled();
	});
	it('cancels a pending script mount on cleanup without disturbing other widgets', async () => {
		vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key');
		document.body.innerHTML = '<div id="restock-security"></div>';
		const { mountTurnstile } = await import('./turnstile-widget');
		const cleanup = mountTurnstile('restock-security', vi.fn(), vi.fn());
		const script = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
		expect(script).toBeTruthy();
		cleanup();
		const render = vi.fn();
		vi.stubGlobal('turnstile', { render });
		script?.dispatchEvent(new Event('load'));
		expect(render).not.toHaveBeenCalled();
	});
});

describe('mountTurnstileOnIntent (P7/V34)', () => {
	const scripts = () => document.querySelectorAll('script[src*="challenges.cloudflare.com/turnstile"]').length;

	it('loads nothing until the shopper engages the newsletter form, then mounts once', async () => {
		vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key');
		document.body.innerHTML = '<main><a id="other" href="#">x</a><section id="nl"><input id="email" type="email"><div id="nl-turnstile"></div></section></main>';
		const { mountTurnstileOnIntent } = await import('./turnstile-widget');
		const cleanup = mountTurnstileOnIntent('nl-turnstile', vi.fn(), vi.fn());
		expect(scripts()).toBe(0);
		document.getElementById('other')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		expect(scripts()).toBe(0);
		document.getElementById('email')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		expect(scripts()).toBe(1);
		document.getElementById('email')!.dispatchEvent(new Event('input', { bubbles: true }));
		expect(scripts()).toBe(1);
		cleanup();
	});

	it('uses the enclosing <form> as the intent region and works for a container rendered later', async () => {
		vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key');
		const { mountTurnstileOnIntent } = await import('./turnstile-widget');
		const cleanup = mountTurnstileOnIntent('nl-turnstile', vi.fn(), vi.fn());
		document.body.innerHTML = '<form><button id="go" type="button">go</button><div id="nl-turnstile"></div></form>';
		document.getElementById('go')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		expect(scripts()).toBe(1);
		cleanup();
	});

	it('cleanup before intent removes the listeners; no site key is a no-op', async () => {
		vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key');
		document.body.innerHTML = '<section><input id="email"><div id="nl-turnstile"></div></section>';
		const { mountTurnstileOnIntent } = await import('./turnstile-widget');
		mountTurnstileOnIntent('nl-turnstile', vi.fn(), vi.fn())();
		document.getElementById('email')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		expect(scripts()).toBe(0);
		vi.resetModules();
		vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '');
		const fresh = await import('./turnstile-widget');
		fresh.mountTurnstileOnIntent('nl-turnstile', vi.fn(), vi.fn());
		document.getElementById('email')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		expect(scripts()).toBe(0);
	});
});
