/**
 * Google sign-in (Google Identity Services) switch and the CSP origins it needs.
 *
 * ONE configuration source for both the sign-in button and the CSP: the compiled `VITE_GOOGLE_CLIENT_ID`, read through
 * `googleSignInClientId()` below by the page and by `entry.express.tsx` alike (a runtime-only variable can never open
 * the CSP without the button, or the reverse).
 *
 * Per store: the shop config (`GET /v1/shop/config`) does not expose a store's Google client id, and the CSP is built
 * before any store is resolved, so the feature is restricted to a deployment pinned to a single store
 * (`VITE_SELLRIGHT_STORE_SLUG`, which makes every request resolve that one store). Without a pin the feature is
 * refused: no button, no Google origins. The API still verifies the credential against that store's own client id.
 *
 * Per host: a pin alone is not enough, because a pinned process answers every host that reaches it while the browser
 * resolves the store by host. `SELLRIGHT_GOOGLE_SIGNIN_HOSTS` (comma-separated public hosts, no port) names the hosts that
 * belong to the pinned store; the client id and the CSP origins are resolved per request from the VALIDATED request host
 * (`validatedRequestHost`, utils/trusted-request.server.ts) and a host not listed gets neither (fail closed, so an
 * unset list means no Google sign-in anywhere).
 *
 * Origins are those Google documents for GIS (developers.google.com/identity/gsi/web/guides/get-google-api-clientid):
 * the library URL for script-src, the `/gsi/` parent for frames and connect, `/gsi/style` for styles.
 */
export const GOOGLE_IDENTITY_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

const GSI = 'https://accounts.google.com/gsi/';

/** Runtime env, server only (this module is also bundled for the browser, where there is no `process`). */
const serverEnv = (name: string): string | undefined => (typeof process !== 'undefined' ? process.env?.[name] : undefined);

export function googleClientId(raw: unknown = import.meta.env.VITE_GOOGLE_CLIENT_ID): string {
	return typeof raw === 'string' ? raw.trim() : '';
}

/** The client id for this deployment, or '' when Google sign-in is off. Both the button and the CSP call this. A client
 *  id without a store pin is refused (see the module note), so one store's setting never reaches another store. */
export function googleSignInClientId(
	raw: unknown = import.meta.env.VITE_GOOGLE_CLIENT_ID,
	storePin: unknown = import.meta.env.VITE_SELLRIGHT_STORE_SLUG,
): string {
	const id = googleClientId(raw);
	if (!id) return '';
	return typeof storePin === 'string' && storePin.trim() ? id : '';
}

/** Hosts of the pinned store that may offer Google sign-in (`SELLRIGHT_GOOGLE_SIGNIN_HOSTS`), lowercase, no port. */
export function googleSignInHosts(raw: unknown = serverEnv('SELLRIGHT_GOOGLE_SIGNIN_HOSTS')): string[] {
	if (typeof raw !== 'string') return [];
	return raw
		.split(',')
		.map((h) => h.trim().toLowerCase().replace(/:\d+$/, ''))
		.filter(Boolean);
}

/** The client id for a request to `host` (already validated and port-free), or '' when Google sign-in is off for it:
 *  no client id, no store pin, or a host outside the pinned store's list. Page and CSP both call this per request. */
export function googleSignInClientIdForHost(
	host: string,
	raw: unknown = import.meta.env.VITE_GOOGLE_CLIENT_ID,
	storePin: unknown = import.meta.env.VITE_SELLRIGHT_STORE_SLUG,
	hostsRaw: unknown = serverEnv('SELLRIGHT_GOOGLE_SIGNIN_HOSTS'),
): string {
	const id = googleSignInClientId(raw, storePin);
	if (!id || !host) return '';
	return googleSignInHosts(hostsRaw).includes(host.toLowerCase()) ? id : '';
}

/** True when a client id is configured but refused for want of a store pin (callers log it once at startup). */
export function googleSignInRefusedForMissingPin(
	raw: unknown = import.meta.env.VITE_GOOGLE_CLIENT_ID,
	storePin: unknown = import.meta.env.VITE_SELLRIGHT_STORE_SLUG,
): boolean {
	return googleClientId(raw) !== '' && googleSignInClientId(raw, storePin) === '';
}

export interface GoogleIdentityCsp {
	script: string[];
	connect: string[];
	frame: string[];
	style: string[];
}

/** Extra CSP sources for Google Identity: none unless a client id is configured. */
export function googleIdentityCsp(clientId: string): GoogleIdentityCsp {
	if (!clientId) return { script: [], connect: [], frame: [], style: [] };
	return { script: [GOOGLE_IDENTITY_SCRIPT_URL], connect: [GSI], frame: [GSI], style: [`${GSI}style`] };
}
