export interface PostalLookupResult {
  city: string;
  province: string;
}

// Countries supported by zippopotam.us (ISO alpha-2, lowercase).
const ZIPPO_COUNTRIES = new Set([
  'ad','ar','as','at','au','ax','az','bd','be','bg','bm','br','by','ca','ch','cl','co','cr','cz',
  'de','dk','do','dz','es','fi','fm','fo','fr','gb','gf','gg','gl','gp','gt','gu','hr','hu','ie',
  'im','in','is','it','je','jp','li','lk','lt','lu','lv','mc','md','mh','mk','mp','mq','mt','mx',
  'my','nc','nl','no','nz','pe','ph','pk','pl','pm','pr','pt','re','ro','ru','se','si','sj','sk',
  'sm','th','tr','ua','us','va','vi','wf','yt','za',
]);

/**
 * Look up city + state/province from country + postal code.
 * Supported countries use zippopotam.us.
 * Returns null on any failure — caller should leave fields empty for manual entry.
 */
export async function lookupPostalCode(
  countryCode: string,
  postalCode: string,
  signal?: AbortSignal,
): Promise<PostalLookupResult | null> {
  if (!countryCode || !postalCode) return null;
  const cc = countryCode.toLowerCase();
  const trimmed = postalCode.trim();
  if (trimmed.length < 3) return null;

  if (!ZIPPO_COUNTRIES.has(cc)) return null;

  try {
    const res = await fetch(`https://api.zippopotam.us/${cc}/${encodeURIComponent(trimmed)}`, {
      signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      places?: Array<{ 'place name'?: string; state?: string; 'state abbreviation'?: string }>;
    };
    const first = data.places?.[0];
    if (!first) return null;
    // Prefer 2-letter abbreviation (US "CA"); fall back to full name when abbr is numeric
    // or missing (PT returns numeric region codes like "15" — full name "Setubal" is friendlier)
    const abbr = first['state abbreviation'];
    const province = abbr && !/^\d+$/.test(abbr) ? abbr : (first.state || abbr || '');
    return {
      city: first['place name'] || '',
      province,
    };
  } catch {
    return null;
  }
}
