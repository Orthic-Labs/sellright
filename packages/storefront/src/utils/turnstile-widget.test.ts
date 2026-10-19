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
