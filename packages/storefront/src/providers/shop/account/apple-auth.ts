/**
 * Sign in with Apple. Browser-only: loads Apple's JS SDK on demand and opens its popup; the identity token it hands
 * back is verified server-side by `POST /v1/shop/auth/apple` before the API creates the session cookies, exactly as
 * password login and Google sign-in do.
 */
import { APPLE_AUTH_SCRIPT_URL } from '~/config/apple-signin';
import { sellright } from '~/sellright/client';
import { describeAccountError } from '~/sellright/types/account';
import type { LoginResult } from './account';

/** Exchange an Apple identity token for a session. 401 = token rejected; 409 = not configured, or an existing account owns the email and Apple cannot vouch for it. */
export async function loginWithApple(identityToken: string): Promise<LoginResult> {
	try {
		const { data } = await sellright().POST('/v1/shop/auth/apple', { body: { identityToken } });
		// 202: Apple cannot vouch for this address, so the API mailed it a confirmation link instead of signing in. The
		// reply is identical whether or not an account exists; say only that.
		if (!data || !('customer' in data)) return { ok: false, code: 'unknown', message: 'Check your email: we sent a link to confirm this Apple sign-in. Open it in this same browser; it expires in 30 minutes.' };
		return { ok: true, customer: data.customer };
	} catch (e) {
		const err = describeAccountError(e);
		const status = (e as { status?: number } | null)?.status;
		if (status === 401) return { ok: false, code: 'unknown', message: 'Apple sign-in could not be verified. Please try again.' };
		if (status === 409) return { ok: false, code: 'unknown', message: err.message.trim() || 'Apple sign-in is not available for this account. Sign in with your password or a sign-in link first.' };
		return { ok: false, ...err };
	}
}

type AppleSignInResponse = { authorization?: { id_token?: string; code?: string }; user?: unknown };
type AppleAuth = {
	init(config: { clientId: string; scope: string; redirectURI: string; usePopup: boolean }): void;
	signIn(): Promise<AppleSignInResponse>;
};
const appleAuth = () => (window as unknown as { AppleID?: { auth?: AppleAuth } }).AppleID?.auth;

let loading: Promise<AppleAuth> | undefined;

/** How long the SDK download may take before it counts as failed. */
export const APPLE_SCRIPT_TIMEOUT_MS = 10_000;

/** The per-request CSP nonce the server stamped on this document's own scripts (read from the DOM, never invented). */
function documentNonce(): string {
	const el = document.querySelector<HTMLScriptElement>('script[nonce]');
	return el?.nonce || el?.getAttribute('nonce') || '';
}

function loadSdk(): Promise<AppleAuth> {
	loading ??= new Promise<AppleAuth>((resolve, reject) => {
		const ready = appleAuth();
		if (ready) return resolve(ready);
		const script = document.createElement('script');
		let settled = false;
		const timer = setTimeout(() => fail(new Error('Apple sign-in timed out')), APPLE_SCRIPT_TIMEOUT_MS);
		const fail = (e: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			script.remove(); // a retry inserts a fresh script rather than waiting on this one
			reject(e);
		};
		script.src = APPLE_AUTH_SCRIPT_URL;
		script.async = true;
		const nonce = documentNonce();
		if (nonce) script.nonce = nonce;
		script.onload = () => {
			const auth = appleAuth();
			if (!auth) return fail(new Error('Apple sign-in unavailable'));
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(auth);
		};
		script.onerror = () => fail(new Error('Apple sign-in failed to load'));
		document.head.appendChild(script);
	}).catch((e) => {
		loading = undefined; // failure or timeout clears the pending loader so a retry starts clean
		throw e;
	});
	return loading;
}

export type AppleSignInOutcome = { status: 'token'; identityToken: string } | { status: 'cancelled' } | { status: 'unavailable' };

/** Start loading Apple's SDK as soon as the sign-in page shows the Apple button. Safari only lets the popup open while
 *  the click is still being handled, so `signIn()` must not wait on a script download after the click. Never throws;
 *  a failed preload leaves the click to retry the load. */
export function preloadAppleSdk(): Promise<void> {
	return loadSdk().then(
		() => undefined,
		() => undefined,
	);
}

/** Open Apple's popup and resolve its identity token. `cancelled` = the shopper closed the popup; `unavailable` = the SDK
 *  could not load or Apple returned no token. The SDK is normally preloaded (preloadAppleSdk); otherwise it loads here. */
export async function signInWithApple(clientId: string): Promise<AppleSignInOutcome> {
	let auth: AppleAuth;
	try {
		auth = await loadSdk();
	} catch {
		return { status: 'unavailable' };
	}
	try {
		auth.init({ clientId, scope: 'name email', redirectURI: `${window.location.origin}/sign-in`, usePopup: true });
		const res = await auth.signIn();
		const identityToken = res?.authorization?.id_token;
		return identityToken ? { status: 'token', identityToken } : { status: 'unavailable' };
	} catch (e) {
		const code = (e as { error?: string } | null)?.error;
		if (code === 'popup_closed_by_user' || code === 'user_cancelled_authorize') return { status: 'cancelled' };
		return { status: 'unavailable' };
	}
}
