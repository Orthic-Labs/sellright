/**
 * Account auth provider — native SellRight client (PASS 3). Talks to the API
 * exclusively through `~/sellright/client` (`sellright()`, generated
 * `paths`); every result is
 * either the plain native payload or a `describeAccountError` `{ code,
 * message }`, built from `SellRightError.code`/`.status` — never a
 * a legacy discriminated-union `errorCode` field.
 */
import { sellright, SellRightError } from '~/sellright/client';
import { describeAccountError, type AccountError, type AuthCustomer, type ProfileUpdateResult } from '~/sellright/types/account';

export type LoginResult = { ok: true; customer: AuthCustomer } | ({ ok: false } & AccountError);

/** R21-equivalent: `rememberMe` is forwarded to the API for real (the SellRight
 *  API session-lengths on it — default true = long-lived, false = 1-day). */
export async function login(
	email: string,
	password: string,
	opts: { turnstileToken?: string; rememberMe?: boolean } = {},
): Promise<LoginResult> {
	try {
		const { data } = await sellright().POST('/v1/shop/auth/login', {
			body: { email, password, turnstileToken: opts.turnstileToken, rememberMe: opts.rememberMe },
		});
		return { ok: true, customer: data!.customer };
	} catch (e) {
		const err = describeAccountError(e, { 401: 'invalid_credentials' });
		return { ok: false, ...err };
	}
}

export type LogoutResult = { ok: true } | { ok: false; error: string };

/** Best-effort for a genuinely unreachable API, but a CSRF rejection (403)
 *  means the server session is still live — that must not be reported as a
 *  success (the caller decides what to show; this never lies about it). */
export async function logout(): Promise<LogoutResult> {
	try {
		await sellright().POST('/v1/shop/auth/logout');
		return { ok: true };
	} catch (e) {
		if (e instanceof SellRightError && e.status === 403) {
			return { ok: false, error: e.message || 'Could not sign out — please try again.' };
		}
		// Any other transport failure (network down, API unreachable): the
		// session is unverifiable either way, so the client still clears its
		// own state — but the failure is real and gets surfaced, not swallowed.
		return { ok: false, error: e instanceof Error ? e.message : 'Sign out failed.' };
	}
}

/** Ask for a one-time sign-in link by email. Enumeration-safe on the API side (identical 200 whether or not the address
 *  has an account); a store that has not switched the feature on answers 409. */
export async function requestMagicLink(email: string, turnstileToken?: string): Promise<SimpleResult> {
	try {
		await sellright().POST('/v1/shop/auth/magic-link/request', { body: { email, turnstileToken } });
		return { ok: true };
	} catch (e) {
		return { ok: false, ...describeAccountError(e, { 409: 'magic_link_disabled' }) };
	}
}

/** Exchange the one-time token from the emailed link for a session (the API sets the session cookies). */
export async function consumeMagicLink(token: string): Promise<LoginResult> {
	try {
		const { data } = await sellright().POST('/v1/shop/auth/magic-link/consume', { body: { token } });
		return { ok: true, customer: data!.customer };
	} catch (e) {
		return { ok: false, ...describeAccountError(e, { 409: 'invalid_token' }) };
	}
}

export type RegisterInput = {
	email: string;
	password: string;
	firstName?: string;
	lastName?: string;
	turnstileToken?: string;
};

export type RegisterResult = { ok: true; customer: AuthCustomer } | ({ ok: false } & AccountError);

export async function register(input: RegisterInput): Promise<RegisterResult> {
	try {
		const { data } = await sellright().POST('/v1/shop/auth/register', { body: input });
		return { ok: true, customer: data!.customer };
	} catch (e) {
		return { ok: false, ...describeAccountError(e, { 409: 'email_taken' }) };
	}
}

export type SimpleResult = { ok: true } | ({ ok: false } & AccountError);

/** Always resolves `ok: true` on the happy path AND on a transient failure —
 *  the API's own resend-verification endpoint is enumeration-safe (always
 *  200), so this mirrors that: never leak whether the address exists. */
export async function resendVerification(email: string, turnstileToken?: string): Promise<{ ok: true }> {
	try {
		await sellright().POST('/v1/shop/auth/resend-verification', { body: { email, turnstileToken } });
	} catch {
		// enumeration-safe: no-op
	}
	return { ok: true };
}

export async function verifyEmail(token: string): Promise<SimpleResult> {
	try {
		await sellright().POST('/v1/shop/auth/verify-email', { body: { token } });
		return { ok: true };
	} catch (e) {
		return { ok: false, ...describeAccountError(e, { 409: 'invalid_token' }) };
	}
}

export type UpdateProfileInput = { firstName?: string | null; lastName?: string | null; phone?: string | null };

export async function updateProfile(input: UpdateProfileInput): Promise<ProfileUpdateResult> {
	const { data } = await sellright().PATCH('/v1/shop/account/me', { body: input });
	return data!;
}

/** Request an email-address change — verification goes to the NEW address.
 *  The API requires the current password to confirm the change. */
export async function requestEmailChange(newEmail: string, password: string): Promise<SimpleResult> {
	try {
		await sellright().POST('/v1/shop/auth/request-email-change', { body: { newEmail, password } });
		return { ok: true };
	} catch (e) {
		return { ok: false, ...describeAccountError(e, { 401: 'wrong_password', 409: 'email_unavailable' }) };
	}
}

export async function verifyEmailChange(token: string): Promise<SimpleResult> {
	try {
		await sellright().POST('/v1/shop/auth/verify-email-change', { body: { token } });
		return { ok: true };
	} catch (e) {
		return { ok: false, ...describeAccountError(e, { 409: 'invalid_token' }) };
	}
}

export async function resetPassword(token: string, password: string): Promise<SimpleResult> {
	try {
		await sellright().POST('/v1/shop/auth/reset-password', { body: { token, password } });
		return { ok: true };
	} catch (e) {
		return { ok: false, ...describeAccountError(e, { 409: 'invalid_token' }) };
	}
}

/** The API is enumeration-safe (always 200) — mirror that unconditionally, do
 *  not leak account existence on a transient failure either. */
export async function requestPasswordReset(email: string, turnstileToken?: string): Promise<{ ok: true }> {
	try {
		await sellright().POST('/v1/shop/auth/forgot-password', { body: { email, turnstileToken } });
	} catch {
		// enumeration-safe: no-op
	}
	return { ok: true };
}
