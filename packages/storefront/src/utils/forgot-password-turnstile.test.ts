import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('forgot-password sends a Turnstile token when a site key is configured', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it('the page mounts the shared widget, blocks submit without a token and forwards it', () => {
		const src = read('src/routes/forgot-password/index.tsx');
		expect(src).toContain("from '~/utils/turnstile-widget'");
		expect(src).toContain("mountTurnstile('forgot-turnstile'");
		expect(src).toContain('TURNSTILE_SITE_KEY && !turnstileToken.value');
		expect(src).toContain('requestPasswordReset(email.value, token || undefined)');
		expect(src).toContain('resetTurnstile()');
	});

	it('POST /v1/shop/auth/forgot-password carries turnstileToken; without one the field is simply absent', async () => {
		const bodies: unknown[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
			const text = input instanceof Request ? await input.clone().text() : String(init?.body ?? '');
			bodies.push(JSON.parse(text));
			return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
		}));
		const { requestPasswordReset } = await import('~/providers/shop/account/account');
		await requestPasswordReset('a@b.co', 'tok_123');
		await requestPasswordReset('a@b.co');
		expect(bodies[0]).toEqual({ email: 'a@b.co', turnstileToken: 'tok_123' });
		expect(bodies[1]).toEqual({ email: 'a@b.co' });
	});

	it('the widget helper is a no-op without a site key (page unchanged when none is configured)', async () => {
		vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '');
		const { mountTurnstile, TURNSTILE_SITE_KEY } = await import('~/utils/turnstile-widget');
		expect(TURNSTILE_SITE_KEY).toBe('');
		const before = document.head.querySelectorAll('script').length;
		mountTurnstile('forgot-turnstile', () => {}, () => {});
		expect(document.head.querySelectorAll('script').length).toBe(before);
	});
});
