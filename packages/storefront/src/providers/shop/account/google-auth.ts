/**
 * Sign in with Google (Google Identity Services). Browser-only: loads Google's library on demand and renders the
 * button; the credential it hands back is an ID token, which the native API (`POST /v1/shop/auth/google`) verifies
 * server-side before it creates the session cookies, exactly as login does.
 */
import { GOOGLE_IDENTITY_SCRIPT_URL } from '~/config/google-signin';
import { sellright } from '~/sellright/client';
import { describeAccountError } from '~/sellright/types/account';
import type { LoginResult } from './account';

/** Exchange a Google credential for a session. 409 = Google sign-in is not configured for this store, or an existing account owns the email and Google cannot vouch for it; 401 = Google token rejected. */
export async function loginWithGoogle(credential: string): Promise<LoginResult> {
	try {
		const { data } = await sellright().POST('/v1/shop/auth/google', { body: { credential } });
		// 202: Google cannot vouch for this address, so the API mailed it a verification link instead of signing in. The
		// reply is the same whether or not an account exists; say only that, never anything account-specific.
		if (!data || !('customer' in data)) return { ok: false, code: 'unknown', message: 'Check your email: we sent a link to confirm this Google sign-in. Open it in this same browser; it expires in 30 minutes.' };
		return { ok: true, customer: data.customer };
	} catch (e) {
		const err = describeAccountError(e);
		const status = (e as { status?: number } | null)?.status;
		// 401: Google rejected the credential. 409: store not configured, or an unverified password account owns the email
		// (the API's message says which). Never the password-login wording.
		if (status === 401) return { ok: false, code: 'unknown', message: 'Google sign-in could not be verified. Please try again.' };
		// 409 carries the API's own explanation (not configured / an existing account must sign in first); show it.
		if (status === 409) return { ok: false, code: 'unknown', message: err.message.trim() || 'Google sign-in is not available for this account. Sign in with your password or a sign-in link first.' };
		return { ok: false, ...err };
	}
}

/** Redeem the emailed federated sign-in link (proof of current control of the address) for a session. The API also needs
 *  the nonce cookie set when the flow started, so this only succeeds in the browser that began it. */
export async function confirmFederatedSignIn(token: string): Promise<LoginResult> {
	try {
		const { data } = await sellright().POST('/v1/shop/auth/federated/confirm', { body: { token } });
		return { ok: true, customer: data!.customer };
	} catch (e) {
		const err = describeAccountError(e);
		const status = (e as { status?: number } | null)?.status;
		if (status === 401) return { ok: false, code: 'unknown', message: 'This link is invalid, has expired, was already used, or was opened in a different browser than the one you started in. Please sign in again.' };
		if (status === 409) return { ok: false, code: 'unknown', message: err.message.trim() || 'Sign in with your password and verify your email first.' };
		return { ok: false, ...err };
	}
}

type GoogleId = {
	initialize(config: { client_id: string; callback: (r: { credential?: string }) => void; auto_select: boolean; ux_mode: 'popup' }): void;
	renderButton(el: HTMLElement, options: Record<string, unknown>): void;
};
const gis = () => (window as unknown as { google?: { accounts?: { id?: GoogleId } } }).google?.accounts?.id;

let loading: Promise<GoogleId> | undefined;

/** How long the library download may take before it counts as failed. */
export const GOOGLE_SCRIPT_TIMEOUT_MS = 10_000;

/** The per-request CSP nonce the server stamped on this document's own scripts (read from the DOM, never invented). */
function documentNonce(): string {
	const el = document.querySelector<HTMLScriptElement>('script[nonce]');
	return el?.nonce || el?.getAttribute('nonce') || '';
}

function loadLibrary(): Promise<GoogleId> {
	loading ??= new Promise<GoogleId>((resolve, reject) => {
		const ready = gis();
		if (ready) return resolve(ready);
		const script = document.createElement('script');
		let settled = false;
		const timer = setTimeout(() => fail(new Error('Google Identity timed out')), GOOGLE_SCRIPT_TIMEOUT_MS);
		const fail = (e: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			script.remove(); // a retry inserts a fresh script rather than waiting on this one
			reject(e);
		};
		script.src = GOOGLE_IDENTITY_SCRIPT_URL;
		script.async = true;
		const nonce = documentNonce();
		if (nonce) script.nonce = nonce;
		script.onload = () => {
			const id = gis();
			if (!id) return fail(new Error('Google Identity unavailable'));
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(id);
		};
		script.onerror = () => fail(new Error('Google Identity failed to load'));
		document.head.appendChild(script);
	}).catch((e) => {
		loading = undefined; // failure or timeout clears the pending loader so a retry starts clean
		throw e;
	});
	return loading;
}

/** Render the Google button into `container`. Resolves false (button stays absent) when the library cannot load. */
export async function renderGoogleButton(container: HTMLElement, clientId: string, onCredential: (credential: string) => void): Promise<boolean> {
	try {
		const id = await loadLibrary();
		id.initialize({
			client_id: clientId,
			callback: (r) => {
				if (r?.credential) onCredential(r.credential);
			},
			auto_select: false,
			ux_mode: 'popup',
		});
		id.renderButton(container, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', logo_alignment: 'left', width: container.clientWidth || 320 });
		return true;
	} catch {
		return false;
	}
}
