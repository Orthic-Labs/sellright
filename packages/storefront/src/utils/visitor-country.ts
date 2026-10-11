/**
 * Visitor country detection. First party first: the CDN country header, read
 * server-side by `routes/api/country`, answers without an extra DNS + TLS
 * round trip and without sending the visitor's IP to a third party. The
 * third-party lookup is only the fallback for when the edge gives no answer
 * (local dev without a CDN, unknown or Tor visitors).
 */

/** The CDN header carrying the visitor's ISO 3166-1 alpha-2 country. */
export const COUNTRY_HEADER = 'cf-ipcountry';

/** Normalise the CDN country header. XX (unknown) and T1 (Tor) are "no answer". */
export function parseCdnCountry(raw: string | null | undefined): string | null {
	const code = (raw ?? '').trim().toUpperCase();
	return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : null;
}

/**
 * Whether the browser may fall back to the third-party lookup (`VITE_IP_COUNTRY_FALLBACK`; unset = on, `0`/`false`/`off` = off).
 * The Express CSP reads the same value to decide whether `connect-src` allows that origin (`utils/csp.ts`), so the
 * client fallback and the policy cannot disagree.
 */
export function ipCountryFallbackEnabled(raw: string | null | undefined): boolean {
	return !['0', 'false', 'off'].includes((raw ?? '').trim().toLowerCase());
}

/**
 * Whether the request came through an edge that overwrites the country header (`BEHIND_CLOUDFLARE=1`, the same opt-in the API
 * uses for CF-Connecting-IP). Without it a client reaching the origin directly can send any value, so the header is ignored.
 */
export function trustsCdnCountryHeader(raw: string | null | undefined): boolean {
	return (raw ?? '').trim() === '1';
}

const sources = (): Array<{ url: string; timeoutMs: number }> => [
	{ url: '/api/country/', timeoutMs: 2000 },
	...(ipCountryFallbackEnabled(import.meta.env.VITE_IP_COUNTRY_FALLBACK)
		? [{ url: 'https://ipapi.co/json/', timeoutMs: 3000 }]
		: []),
];

/** Visitor country code from the first source that answers, or null. */
export async function lookupCountryCode(): Promise<string | null> {
	for (const { url, timeoutMs } of sources()) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
			if (!response.ok) continue;
			const data = await response.json();
			if (data?.country_code) return String(data.country_code).toUpperCase();
		} catch (_error) {
			/* try the next source */
		}
	}
	return null;
}
