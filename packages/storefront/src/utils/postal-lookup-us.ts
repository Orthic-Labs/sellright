/**
 * Pure US ZIP-matching logic, deliberately free of any Qwik/server$ import so
 * it can be unit tested directly (importing `@qwik.dev/router` from a vitest
 * file blows up outside the Qwik build pipeline — see postal-lookup-server.tsx
 * for why the dataset import + server$() wrapper stay together in one file).
 */
export interface PostalLookupResult {
	city: string;
	province: string;
}

/**
 * Match a US postal code against a ZIP -> [city, state] table.
 * Strict US ZIP: exactly 5 digits (basic) or 9 digits (ZIP+4). Anything else
 * is not a valid US postal code — silently truncating would return a ghost
 * match (e.g. a 6-digit non-US postal code could collide with a real 5-digit
 * US ZIP prefix). Fail closed instead.
 */
export function matchUsZip(zipDb: Record<string, string[]>, postal: string): PostalLookupResult | null {
	const cleaned = postal.replace(/[^0-9]/g, '');
	if (cleaned.length !== 5 && cleaned.length !== 9) return null;
	const entry = zipDb[cleaned.slice(0, 5)];
	if (!entry || entry.length < 2) return null;
	return { city: entry[0]!, province: entry[1]! };
}
