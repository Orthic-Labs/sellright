import { lookupPostalServer, type PostalLookupResult as ServerPostalLookupResult } from './postal-lookup-server';
import { postalLookupApplies } from './postal-lookup-core';

export type PostalLookupResult = ServerPostalLookupResult;

/**
 * Look up city + state/province from country + postal code, on the server (postal-lookup-server.tsx): the browser
 * makes no third-party request. Nothing is sent unless the code is a valid postcode for this country, so a ZIP left
 * over from another country (78701 after switching US -> GB) is never looked up.
 * Returns null on any failure — caller should leave fields empty for manual entry.
 */
export async function lookupPostalCode(countryCode: string, postalCode: string): Promise<PostalLookupResult | null> {
	if (!postalLookupApplies(countryCode, postalCode)) return null;
	try {
		return await lookupPostalServer(countryCode.toUpperCase(), postalCode.trim());
	} catch {
		return null;
	}
}
