/**
 * Google sign-in (Google Identity Services) switch and the CSP origins it needs.
 *
 * Enabled only when a Google OAuth client id is configured (`VITE_GOOGLE_CLIENT_ID`; empty by default = off).
 * The shop config (`GET /v1/shop/config`) does not yet say whether a store has Google sign-in on, so this build/runtime
 * value is the switch; the API still verifies the credential against the store's own client id and answers 409 when
 * the store has none. When the API serves the client id per store, this module is the one place to read it.
 *
 * Origins are those Google documents for GIS (developers.google.com/identity/gsi/web/guides/get-google-api-clientid):
 * the library URL for script-src, the `/gsi/` parent for frames and connect, `/gsi/style` for styles.
 */
export const GOOGLE_IDENTITY_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

const GSI = 'https://accounts.google.com/gsi/';

export function googleClientId(raw: unknown = import.meta.env.VITE_GOOGLE_CLIENT_ID): string {
	return typeof raw === 'string' ? raw.trim() : '';
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
