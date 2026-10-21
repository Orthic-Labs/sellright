/**
 * Sign in with Apple (Sign in with Apple JS) switch and the CSP origins it needs.
 *
 * ONE configuration source for both the sign-in button and the CSP: the compiled `VITE_APPLE_CLIENT_ID`, read through
 * `appleSignInClientId()` below by the page and by `entry.express.tsx` alike (a runtime-only variable can never open
 * the CSP without the button, or the reverse).
 *
 * Per store: the shop config (`GET /v1/shop/config`) does not expose a store's Apple client id, and the CSP is built
 * before any store is resolved, so the feature is restricted to a deployment pinned to a single store
 * (`VITE_SELLRIGHT_STORE_SLUG`, which makes every request resolve that one store). Without a pin the feature is
 * refused: no button, no Apple origins. The API still verifies the credential against that store's own client id.
 *
 * Per host: a pin alone is not enough, because a pinned process answers every host that reaches it while the browser
 * resolves the store by host. `SELLRIGHT_APPLE_SIGNIN_HOSTS` (comma-separated public hosts, no port) names the hosts that
 * belong to the pinned store; the client id and the CSP origins are resolved per request from the VALIDATED request host
 * (`validatedRequestHost`, utils/trusted-request.server.ts) and a host not listed gets neither (fail closed, so an
 * unset list means no Apple sign-in anywhere).
 *
 * Origins: the Sign in with Apple JS library URL for script-src, and appleid.apple.com for the popup's frame and the
 * connect calls the library makes. No style origin is needed.
 */
export const APPLE_AUTH_SCRIPT_URL = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';

const APPLE_ID = 'https://appleid.apple.com';

/** Runtime env, server only (this module is also bundled for the browser, where there is no `process`). */
const serverEnv = (name: string): string | undefined => (typeof process !== 'undefined' ? process.env?.[name] : undefined);

export function appleClientId(raw: unknown = import.meta.env.VITE_APPLE_CLIENT_ID): string {
	return typeof raw === 'string' ? raw.trim() : '';
}

/** The client id for this deployment, or '' when Apple sign-in is off. Both the button and the CSP call this. A client
 *  id without a store pin is refused (see the module note), so one store's setting never reaches another store. */
export function appleSignInClientId(
	raw: unknown = import.meta.env.VITE_APPLE_CLIENT_ID,
	storePin: unknown = import.meta.env.VITE_SELLRIGHT_STORE_SLUG,
): string {
	const id = appleClientId(raw);
	if (!id) return '';
	return typeof storePin === 'string' && storePin.trim() ? id : '';
}

/** Hosts of the pinned store that may offer Apple sign-in (`SELLRIGHT_APPLE_SIGNIN_HOSTS`), lowercase, no port. */
export function appleSignInHosts(raw: unknown = serverEnv('SELLRIGHT_APPLE_SIGNIN_HOSTS')): string[] {
	if (typeof raw !== 'string') return [];
	return raw
		.split(',')
		.map((h) => h.trim().toLowerCase().replace(/:\d+$/, ''))
		.filter(Boolean);
}

/** The client id for a request to `host` (already validated and port-free), or '' when Apple sign-in is off for it:
 *  no client id, no store pin, or a host outside the pinned store's list. Page and CSP both call this per request. */
export function appleSignInClientIdForHost(
	host: string,
	raw: unknown = import.meta.env.VITE_APPLE_CLIENT_ID,
	storePin: unknown = import.meta.env.VITE_SELLRIGHT_STORE_SLUG,
	hostsRaw: unknown = serverEnv('SELLRIGHT_APPLE_SIGNIN_HOSTS'),
): string {
	const id = appleSignInClientId(raw, storePin);
	if (!id || !host) return '';
	return appleSignInHosts(hostsRaw).includes(host.toLowerCase()) ? id : '';
}

/** True when a client id is configured but refused for want of a store pin (callers log it once at startup). */
export function appleSignInRefusedForMissingPin(
	raw: unknown = import.meta.env.VITE_APPLE_CLIENT_ID,
	storePin: unknown = import.meta.env.VITE_SELLRIGHT_STORE_SLUG,
): boolean {
	return appleClientId(raw) !== '' && appleSignInClientId(raw, storePin) === '';
}

export interface AppleIdentityCsp {
	script: string[];
	connect: string[];
	frame: string[];
	style: string[];
}

/** Extra CSP sources for Sign in with Apple: none unless a client id is configured. */
export function appleIdentityCsp(clientId: string): AppleIdentityCsp {
	if (!clientId) return { script: [], connect: [], frame: [], style: [] };
	return { script: [APPLE_AUTH_SCRIPT_URL], connect: [APPLE_ID], frame: [APPLE_ID], style: [] };
}
