/**
 * Sign in with Google (Google Identity Services). Browser-only: loads Google's library on demand and renders the
 * button; the credential it hands back is an ID token, which the native API (`POST /v1/shop/auth/google`) verifies
 * server-side before it creates the session cookies, exactly as login does.
 */
import { GOOGLE_IDENTITY_SCRIPT_URL } from '~/config/google-signin';
import { sellright } from '~/sellright/client';
import { describeAccountError } from '~/sellright/types/account';
import type { LoginResult } from './account';

/** Exchange a Google credential for a session. 409 = Google sign-in is not configured for this store, or an
 *  unverified password account already owns the email; 401 = Google token rejected. */
export async function loginWithGoogle(credential: string): Promise<LoginResult> {
	try {
		const { data } = await sellright().POST('/v1/shop/auth/google', { body: { credential } });
		return { ok: true, customer: data!.customer };
	} catch (e) {
		const err = describeAccountError(e);
		const status = (e as { status?: number } | null)?.status;
		// 401: Google rejected the credential. 409: store not configured, or an unverified password account owns the email
		// (the API's message says which). Never the password-login wording.
		if (status === 401) return { ok: false, code: 'unknown', message: 'Google sign-in could not be verified. Please try again.' };
		return { ok: false, ...err };
	}
}

type GoogleId = {
	initialize(config: { client_id: string; callback: (r: { credential?: string }) => void; auto_select: boolean; ux_mode: 'popup' }): void;
	renderButton(el: HTMLElement, options: Record<string, unknown>): void;
};
const gis = () => (window as unknown as { google?: { accounts?: { id?: GoogleId } } }).google?.accounts?.id;

let loading: Promise<GoogleId> | undefined;

function loadLibrary(): Promise<GoogleId> {
	loading ??= new Promise<GoogleId>((resolve, reject) => {
		const ready = gis();
		if (ready) return resolve(ready);
		const script = document.createElement('script');
		script.src = GOOGLE_IDENTITY_SCRIPT_URL;
		script.async = true;
		script.onload = () => {
			const id = gis();
			if (id) resolve(id);
			else reject(new Error('Google Identity unavailable'));
		};
		script.onerror = () => reject(new Error('Google Identity failed to load'));
		document.head.appendChild(script);
	}).catch((e) => {
		loading = undefined; // allow a retry after a failed load
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
