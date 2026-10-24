/**
 * Passkeys (WebAuthn) for the storefront: sign-in, and account-side enrol / list / remove.
 *
 * The generated API types do not include these routes yet, so this module talks to them through one small untyped
 * helper (`call`) that sends exactly what `~/sellright/client` sends: store resolution headers, credentials, and the
 * customer CSRF header on mutations. Responses are typed locally. When the client is regenerated, `call` is replaced by
 * `sellright().POST(...)` and nothing else in this file changes.
 *
 * Credential material (challenges, attestation, assertions, grants) is passed straight through and never logged.
 */
import { isServer } from '@qwik.dev/core/build';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/browser';
import type { AccountError, AuthCustomer } from '~/sellright/types/account';
import { apiBase, readCsrfCookie, storeResolutionHeaders } from '~/utils/sellright';
import type { LoginResult } from './account';

export interface PasskeyItem {
	id: string;
	label: string;
	deviceType: 'singleDevice' | 'multiDevice' | string;
	backedUp: boolean;
	createdAt: string;
	lastUsedAt: string | null;
}

export type PasskeyFailure = { ok: false; code: string; message: string; cancelled?: boolean };
export type PasskeyResult<T = Record<never, never>> = ({ ok: true } & T) | PasskeyFailure;
export type PasskeyLoginResult = LoginResult | (AccountError & { ok: false; cancelled: true });

export const PASSKEY_MESSAGES: Record<string, string> = {
	PASSKEY_INVALID: "We couldn't verify that passkey. Try again, or use another sign-in method.",
	CEREMONY_INVALID: 'That request expired or was already used. Please start again.',
	FEATURE_DISABLED: 'Passkeys are not available right now.',
	TOO_MANY_PASSKEYS: 'You have reached the passkey limit. Remove one before adding another.',
	CREDENTIAL_EXISTS: 'This device already has a passkey saved for your account.',
	NO_RECOVERY_PATH: 'Add a password or another sign-in method before removing your last passkey.',
	RATE_LIMITED: 'Too many attempts. Please try again later.',
	UNAUTHENTICATED: 'Please sign in and try again.',
};
export const PASSKEY_CANCELLED_MESSAGE = 'The passkey request was cancelled or timed out. Try again when you are ready.';
export const PASSKEY_UNSUPPORTED_MESSAGE = 'This browser or device does not support passkeys.';
/** Where the emailed-link path remembers what the shopper asked for, so /account/passkeys/confirm can finish it. */
export const PASSKEY_INTENT_KEY = 'sr_passkey_intent';
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

type Envelope = { error?: { code?: string; message?: string } };

class PasskeyApiError extends Error {
	constructor(
		readonly status: number,
		readonly apiCode: string,
		message: string,
	) {
		super(message);
	}
}

/** One untyped call: same transport rules as `~/sellright/client`. Throws `PasskeyApiError` on non-2xx. */
async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = { accept: 'application/json', ...storeResolutionHeaders() };
	if (body !== undefined) headers['content-type'] = 'application/json';
	if (method !== 'GET') {
		const csrf = readCsrfCookie();
		if (csrf) headers['x-csrf-token'] = csrf;
	}
	const res = await fetch(`${isServer ? apiBase() : ''}${path}`, {
		method,
		headers,
		credentials: 'include',
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let parsed: unknown;
	try {
		parsed = text ? JSON.parse(text) : undefined;
	} catch {
		parsed = undefined;
	}
	if (!res.ok) {
		const err = (parsed as Envelope | undefined)?.error;
		throw new PasskeyApiError(res.status, err?.code ?? '', err?.message ?? '');
	}
	return parsed as T;
}

const isCancel = (e: unknown): boolean => {
	const name = (e as { name?: string } | null)?.name;
	return name === 'NotAllowedError' || name === 'AbortError';
};

/** Map any thrown value to a friendly failure. Never includes credential material. */
export function describePasskeyError(e: unknown): PasskeyFailure {
	if (isCancel(e)) return { ok: false, code: 'CANCELLED', message: PASSKEY_CANCELLED_MESSAGE, cancelled: true };
	if (e instanceof PasskeyApiError) {
		const code = e.status === 429 ? 'RATE_LIMITED' : e.apiCode || (e.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN');
		return { ok: false, code, message: PASSKEY_MESSAGES[code] ?? GENERIC_MESSAGE };
	}
	if ((e as { name?: string } | null)?.name === 'InvalidStateError') return { ok: false, code: 'CREDENTIAL_EXISTS', message: PASSKEY_MESSAGES.CREDENTIAL_EXISTS };
	return { ok: false, code: 'UNKNOWN', message: GENERIC_MESSAGE };
}

const P = '/v1/shop/auth/passkey';

/** Modal passkey sign-in, started from a click. No conditional (autofill) ceremony runs in the background: aborting a
 *  pending one to start this modal one breaks extension-based passkey providers (NordPass, 1Password, Bitwarden), which
 *  keep answering the aborted request. Options are fetched here, at click time, so the challenge always matches the nonce
 *  cookie the same request sets. A cancelled prompt returns `cancelled: true` so the page can stay quiet. */
export async function loginWithPasskey(): Promise<PasskeyLoginResult> {
	try {
		const { options } = await call<{ options: PublicKeyCredentialRequestOptionsJSON }>('POST', `${P}/login/options`, {});
		const response = await startAuthentication({ optionsJSON: options });
		const data = await call<{ customer: AuthCustomer }>('POST', `${P}/login/verify`, { response });
		return { ok: true, customer: data.customer };
	} catch (e) {
		const f = describePasskeyError(e);
		if (f.cancelled) return { ok: false, code: 'unknown', message: f.message, cancelled: true };
		return { ok: false, code: f.code === 'RATE_LIMITED' ? 'rate_limited' : 'unknown', message: f.message };
	}
}

const wrap = async <T>(run: () => Promise<T>): Promise<PasskeyResult<T>> => {
	try {
		return { ok: true, ...(await run()) };
	} catch (e) {
		return describePasskeyError(e);
	}
};

/** Grant 1/3: re-enter the account password. */
export const requestGrantWithPassword = (password: string): Promise<PasskeyResult<{ grant: string }>> =>
	wrap(async () => ({ grant: (await call<{ grant: string }>('POST', `${P}/grant/password`, { password })).grant }));

/** Grant 2/3: prove possession of an existing passkey. */
export const grantWithPasskey = (): Promise<PasskeyResult<{ grant: string }>> =>
	wrap(async () => {
		const { options } = await call<{ options: PublicKeyCredentialRequestOptionsJSON }>('POST', `${P}/manage/options`, {});
		const response: AuthenticationResponseJSON = await startAuthentication({ optionsJSON: options });
		return { grant: (await call<{ grant: string }>('POST', `${P}/manage/verify`, { response })).grant };
	});

/** Grant 3/3, step one: email a confirmation link (the API sends it only when eligible; the reply never says). */
export const requestMailboxGrant = (): Promise<PasskeyResult> => wrap(async () => (await call('POST', `${P}/grant/request`, {}), {}));

/** Grant 3/3, step two: redeem the emailed token (same browser that requested it). */
export const confirmMailboxGrant = (token: string): Promise<PasskeyResult<{ grant: string }>> =>
	wrap(async () => ({ grant: (await call<{ grant: string }>('POST', `${P}/grant/confirm`, { token })).grant }));

/** Enrol a passkey on this device. Needs a grant from one of the three paths above. */
export const registerPasskey = (grant: string, label: string): Promise<PasskeyResult<{ passkey: PasskeyItem }>> =>
	wrap(async () => {
		const { options } = await call<{ options: PublicKeyCredentialCreationOptionsJSON }>('POST', `${P}/register/options`, { grant });
		const response: RegistrationResponseJSON = await startRegistration({ optionsJSON: options });
		return { passkey: await call<PasskeyItem>('POST', `${P}/register/verify`, { response, label: label.trim() }) };
	});

export const listPasskeys = (): Promise<PasskeyResult<{ items: PasskeyItem[] }>> =>
	wrap(async () => ({ items: (await call<{ items: PasskeyItem[] }>('GET', '/v1/shop/account/passkeys')).items }));

export const deletePasskey = (id: string, grant: string): Promise<PasskeyResult> =>
	wrap(async () => (await call('DELETE', `/v1/shop/account/passkeys/${encodeURIComponent(id)}`, { grant }), {}));
