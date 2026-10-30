/**
 * Server-side postal lookup: country + postcode -> city + state/province. No Qwik import, so it is unit-testable
 * directly; postal-lookup-server.tsx wraps it in server$(). The browser never calls a third party (storefront CSP
 * stays connect-src 'self'). Every failure (bad format, unknown code, timeout, network or parse error) returns null
 * and the shopper fills the fields by hand.
 *
 * - US: the bundled ZIP table (matchUsZip), no network.
 * - GB: postcodes.io, full postcodes. zippopotam.us only knows outward codes ("SW1A") and names a landmark as the
 *   place, so it is not used for GB. City is the local authority, or "London" inside Greater London; the county is
 *   left blank (optional for GB).
 * - IN: India Post's PIN directory (api.postalpincode.in): district + full state name.
 * - Other countries zippopotam.us covers: zippopotam.us.
 */
import { validatePostcode } from './address-rules';
import { matchUsZip, type PostalLookupResult } from './postal-lookup-us';

export type { PostalLookupResult };

// Countries supported by zippopotam.us (ISO alpha-2, lowercase); US, GB and IN have their own sources above.
const ZIPPO_COUNTRIES = new Set([
	'ad','ar','as','at','au','ax','az','bd','be','bg','bm','br','by','ca','ch','cl','co','cr','cz',
	'de','dk','do','dz','es','fi','fm','fo','fr','gf','gg','gl','gp','gt','gu','hr','hu','ie',
	'im','is','it','je','jp','li','lk','lt','lu','lv','mc','md','mh','mk','mp','mq','mt','mx',
	'my','nc','nl','no','nz','pe','ph','pk','pl','pm','pr','pt','re','ro','ru','se','si','sj','sk',
	'sm','th','tr','ua','va','vi','wf','yt','za',
]);

const TIMEOUT_MS = 3000;
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const clean = (v: unknown, max = 100): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : '');

/** True when the code is worth looking up for this country: a well-formed postcode, so a code typed for another country is never sent. */
export function postalLookupApplies(countryCode: string, postalCode: string): boolean {
	const cc = (countryCode || '').toUpperCase();
	const code = (postalCode || '').trim();
	if (!/^[A-Z]{2}$/.test(cc) || code.length < 3 || code.length > 20) return false;
	if (!validatePostcode(code, cc).isValid) return false;
	return cc === 'US' || cc === 'GB' || cc === 'IN' || ZIPPO_COUNTRIES.has(cc.toLowerCase());
}

export async function lookupPostal(
	countryCode: string,
	postalCode: string,
	deps: { zipDb: Record<string, string[]>; fetch?: typeof fetch; timeoutMs?: number },
): Promise<PostalLookupResult | null> {
	if (!postalLookupApplies(countryCode, postalCode)) return null;
	const cc = countryCode.toUpperCase();
	const code = postalCode.trim();
	if (cc === 'US') return matchUsZip(deps.zipDb, code);
	const get = async (url: string): Promise<unknown> => {
		const res = await (deps.fetch ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS) });
		return res.ok ? res.json() : null;
	};
	try {
		if (cc === 'GB') {
			const data = (await get(`https://api.postcodes.io/postcodes/${encodeURIComponent(code)}`)) as { result?: { admin_district?: string; region?: string } } | null;
			const r = data?.result;
			const city = r?.region === 'London' ? 'London' : clean(r?.admin_district);
			return city ? { city, province: '' } : null;
		}
		if (cc === 'IN') {
			const data = (await get(`https://api.postalpincode.in/pincode/${encodeURIComponent(code.replace(/\s/g, ''))}`)) as Array<{ Status?: string; PostOffice?: Array<{ District?: string; State?: string }> | null }> | null;
			const office = Array.isArray(data) && data[0]?.Status === 'Success' ? data[0].PostOffice?.[0] : undefined;
			const city = clean(office?.District); const province = clean(office?.State);
			return city || province ? { city, province } : null;
		}
		const data = (await get(`https://api.zippopotam.us/${cc.toLowerCase()}/${encodeURIComponent(code)}`)) as { places?: Array<{ 'place name'?: string; state?: string; 'state abbreviation'?: string }> } | null;
		const first = data?.places?.[0];
		if (!first) return null;
		// The full region name: abbreviations are often internal codes a shopper can't read (FR "A8", PT "15").
		const abbr = clean(first['state abbreviation']);
		const province = clean(first.state) || (/^[A-Z]{2,3}$/.test(abbr) ? abbr : '');
		const city = clean(first['place name']);
		return city || province ? { city, province } : null;
	} catch {
		return null;
	}
}
