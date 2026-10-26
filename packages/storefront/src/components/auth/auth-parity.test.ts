import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('LoginModal forgot-password (#389)', () => {
	const src = read('src/components/auth/LoginModal.tsx');

	it('requires and sends the Turnstile token, and shows the real outcome', () => {
		const handler = src.slice(src.indexOf('const handleForgotPassword'), src.indexOf('const handleBack'));
		expect(handler).toContain('TURNSTILE_SITE_KEY && !turnstileToken.value');
		expect(handler).toContain('requestPasswordReset(email.value.trim(), turnstileToken.value || undefined)');
		expect(handler).toContain('passwordResetFailureMessage(result)');
		// "sent" only on ok
		expect(handler).toContain("if (result.ok) step.value = 'reset-sent'");
		expect(handler).toContain('resetChallenge()');
	});

	it('routes an imported no-password account to the set-password step', () => {
		expect(src).toContain('checkEmailStatus');
		expect(src).toContain("status.needsPasswordSetup ? 'setup' : 'signin'");
		expect(src).toContain("step.value === 'setup'");
	});
});

describe('forgot-password page and sign-in "Reset it" (#389)', () => {
	it('the page shows sent only on ok and prompts for an empty email', () => {
		const src = read('src/routes/forgot-password/index.tsx');
		expect(src).toContain('if (result.ok) success.value = true;');
		expect(src).toContain('passwordResetFailureMessage(result)');
		expect(src).toContain("Please enter your email address.");
	});

	it('sign-in "Reset it" prompts for the email and reports the real outcome', () => {
		const src = read('src/routes/sign-in/index.tsx');
		const handler = src.slice(src.indexOf('const handleForgotPassword'), src.indexOf('const handleMagicLink'));
		expect(handler).toContain('Enter your email address above');
		expect(handler).toContain("if (result.ok) view.value = 'reset-sent'");
		expect(handler).toContain('passwordResetFailureMessage(result)');
	});

	it('password-reset enforces the API minimum of 8 and ends on a success notice at sign-in', () => {
		const src = read('src/routes/password-reset/index.tsx');
		expect(src).toContain('MIN_PASSWORD_LENGTH');
		expect(src).toContain("/sign-in?reset=success");
		expect(read('src/routes/sign-in/index.tsx')).toContain('password-reset-success');
	});

	it('account change-password enforces the API minimum of 8', () => {
		const src = read('src/routes/account/password/index.tsx');
		expect(src).toContain('newPassword.value.length < 8');
		expect(src).not.toContain('at least 6');
	});
});

describe('sign-up email-taken wording is neutral, as the previous platform', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it('does not confirm the address is registered and stays on the sign-up step', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'EMAIL_TAKEN', message: 'email already registered' } }), { status: 409, headers: { 'content-type': 'application/json' } })));
		const { registerCustomerFromSignup, SIGNUP_CONFLICT_ERROR } = await import('./signup-flow');
		const result = await registerCustomerFromSignup({ email: 'taken@example.com', password: 'password123', confirmPassword: 'password123', firstName: 'A', lastName: 'B' });
		expect(result).toEqual({ error: SIGNUP_CONFLICT_ERROR });
		expect(result.step).toBeUndefined();
		expect(SIGNUP_CONFLICT_ERROR).not.toMatch(/already exists|already registered/);
	});

	it('rejects a password under 8 characters with a message', async () => {
		const { registerCustomerFromSignup } = await import('./signup-flow');
		const result = await registerCustomerFromSignup({ email: 'a@example.com', password: 'short12', confirmPassword: 'short12', firstName: 'A', lastName: 'B' });
		expect(result.error).toBe('Password must be at least 8 characters.');
	});
});
