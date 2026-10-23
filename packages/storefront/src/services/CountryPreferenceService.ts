/**
 * CountryPreferenceService — the shopper's shipping destination and where it
 * came from.
 *
 * Extracted out of the old cart-item localStorage blob during the native-cart
 * migration (cart-architecture plan): country selection has nothing to do
 * with cart lines, and the native `CartService` keeps no cart data in
 * localStorage (only its opaque token persists client-side, in a cookie).
 *
 * The stored preference records its source:
 *  - `default`  — nothing known yet (US placeholder). The visitor is geolocated once.
 *  - `geo`      — a geolocation result. Cached: never looked up again until reset.
 *  - `explicit` — the shopper's own choice. Geolocation never overwrites it.
 *
 * `reset()` (logout) returns to `default`, so the next visit geolocates once again.
 *
 * Older values stored `{ countryCode, explicit }` without a source. They migrate on read: explicit stays explicit, a
 * non-US code was a geolocation result, and a non-explicit US cannot be told apart from the placeholder so it is
 * `default` (geolocated once more, then cached).
 */
const STORAGE_KEY = 'sr_country_pref';
const LEGACY_CART_KEY = 'vendure_local_cart';
const DEFAULT_COUNTRY = 'US';

export type CountrySource = 'default' | 'geo' | 'explicit';

interface CountryPref {
  countryCode: string;
  source: CountrySource;
}

const DEFAULT_PREF: CountryPref = { countryCode: DEFAULT_COUNTRY, source: 'default' };
const SOURCES: readonly CountrySource[] = ['default', 'geo', 'explicit'];

const isCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]{2}$/.test(value);

/** Source for a value stored before sources were recorded. */
const legacySource = (countryCode: string, explicit: boolean): CountrySource =>
  explicit ? 'explicit' : countryCode === DEFAULT_COUNTRY ? 'default' : 'geo';

function read(): CountryPref {
  if (typeof window === 'undefined') return DEFAULT_PREF;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && isCode(parsed.countryCode)) {
        const source = SOURCES.includes(parsed.source) ? (parsed.source as CountrySource) : legacySource(parsed.countryCode, parsed.explicit === true);
        return { countryCode: parsed.countryCode, source };
      }
    }
  } catch {
    /* corrupt value — fall through to default */
  }
  try {
    const raw = localStorage.getItem(LEGACY_CART_KEY);
    const legacy = raw ? JSON.parse(raw) : null;
    if (isCode(legacy?.countryCode)) {
      return { countryCode: legacy.countryCode, source: legacySource(legacy.countryCode, legacy.countryExplicitlySet === true) };
    }
  } catch { /* Preserve malformed legacy data for explicit reconciliation. */ }
  return DEFAULT_PREF;
}

function write(pref: CountryPref): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
  } catch {
    /* best-effort — a failed write just re-defaults on next read */
  }
}

const normalise = (code: string): string | null => {
  const countryCode = (code || '').toUpperCase();
  return isCode(countryCode) ? countryCode : null;
};

export class CountryPreferenceService {
  static getCountry(): string {
    return read().countryCode || DEFAULT_COUNTRY;
  }

  static getSource(): CountrySource {
    return read().source;
  }

  /** The shopper's own choice: always saved, and it is what stays saved. */
  static setCountry(code: string): void {
    const countryCode = normalise(code || DEFAULT_COUNTRY);
    if (countryCode) write({ countryCode, source: 'explicit' });
  }

  /** Cache a geolocation result. A no-op when the shopper has made an explicit choice. */
  static setCountryFromGeolocation(code: string): void {
    const countryCode = normalise(code);
    if (!countryCode || read().source === 'explicit') return;
    write({ countryCode, source: 'geo' });
  }

  static hasExplicitCountrySelection(): boolean {
    return read().source === 'explicit';
  }

  /** True only while nothing is known: no explicit choice and no cached geolocation result. */
  static needsGeolocation(): boolean {
    return read().source === 'default';
  }

  /** Back to the default state (not explicit, not geolocated), so the next visit geolocates once. */
  static reset(): void {
    write(DEFAULT_PREF);
  }
}
