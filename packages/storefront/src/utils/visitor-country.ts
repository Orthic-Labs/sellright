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

const SOURCES: Array<{ url: string; timeoutMs: number }> = [
	{ url: '/api/country/', timeoutMs: 2000 },
	{ url: 'https://ipapi.co/json/', timeoutMs: 3000 },
];

/** Visitor country code from the first source that answers, or null. */
export async function lookupCountryCode(): Promise<string | null> {
	for (const { url, timeoutMs } of SOURCES) {
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
