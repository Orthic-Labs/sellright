import { ssrRenderToDom, trigger } from '@qwik.dev/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real sign-in page, rendered and resumed: passkeys are modal only. Nothing reaches the passkey flow on load (no
// conditional/autofill ceremony in the background); the button starts exactly one ceremony.
const { loginWithPasskey, navigate } = vi.hoisted(() => ({ loginWithPasskey: vi.fn(), navigate: vi.fn() }));
vi.mock('~/providers/shop/account/passkeys', () => ({ loginWithPasskey: () => loginWithPasskey() }));
vi.mock('~/providers/shop/checkout/checkout', () => ({ getShopConfig: async () => ({ auth: { passkeys: true, magicLink: false } }) }));
vi.mock('@simplewebauthn/browser', () => ({ browserSupportsWebAuthn: () => true, browserSupportsWebAuthnAutofill: async () => true }));
vi.mock('@qwik.dev/router', async () => {
	const { inlinedQrl } = await import('@qwik.dev/core');
	// A real QRL (the page captures navigate inside $()), forwarding to the spy.
	const nav = inlinedQrl((...a: unknown[]) => navigate(...a), 'test_navigate');
	return { routeLoader$: () => () => ({ value: '' }), routeLoaderQrl: () => () => ({ value: '' }), useNavigate: () => nav, Link: () => null };
});
vi.mock('~/utils/social-sign-in.server', () => ({ socialSignInIdsForHost: async () => ({ google: '', apple: '' }) }));
vi.mock('~/utils/trusted-request.server', () => ({ validatedRequestHost: () => 'shop.test' }));
vi.mock('./SignInError', () => ({ SignInError: () => null }));
vi.mock('./seo', () => ({ head: {} }));

const { default: SignIn } = await import('./index');

async function renderResumed() {
	const { document } = await ssrRenderToDom(<SignIn />, {});
	await trigger(document.body, '[q-e\\:qvisible]', 'qvisible'); // runs the page's visible tasks (shop config -> passkeys on)
	return document;
}

beforeEach(() => { loginWithPasskey.mockReset(); navigate.mockReset(); });

describe('sign-in page: modal-only passkeys', () => {
	it('runs no passkey ceremony on load, then the button starts exactly one and signs the shopper in', async () => {
		loginWithPasskey.mockResolvedValue({ ok: true, customer: { id: 'c1' } });
		const document = await renderResumed();
		const button = document.querySelector('[data-testid="passkey-signin-button"]');
		expect(button).toBeTruthy();
		expect(loginWithPasskey).not.toHaveBeenCalled();
		expect(document.querySelector('input[type="email"]')?.getAttribute('autocomplete')).toBe('email');

		await trigger(document.body, '[data-testid="passkey-signin-button"]', 'click');
		expect(loginWithPasskey).toHaveBeenCalledTimes(1);
		expect(navigate).toHaveBeenCalledTimes(1);
	});

	it('a cancelled prompt starts nothing else and leaves the button ready for another try', async () => {
		loginWithPasskey.mockResolvedValue({ ok: false, code: 'unknown', message: 'The passkey request was cancelled or timed out.', cancelled: true });
		const document = await renderResumed();
		await trigger(document.body, '[data-testid="passkey-signin-button"]', 'click');
		expect(loginWithPasskey).toHaveBeenCalledTimes(1);
		expect(navigate).not.toHaveBeenCalled();
		expect((document.querySelector('[data-testid="passkey-signin-button"]') as HTMLButtonElement).disabled).toBe(false);
	});
});
