/**
 * CountryPreferenceService — the shopper's chosen (or geolocated) shipping
 * destination.
 *
 * Extracted out of the old cart-item localStorage blob during the native-cart
 * migration (cart-architecture plan): country selection has nothing to do
 * with cart lines, and the native `CartService` no longer keeps any cart data
 * in localStorage at all (the cart itself is server-owned — only its opaque
 * token persists client-side, in a cookie). This service keeps the shipping
 * destination alive in its own small key instead of disappearing with the
 * retired `vendure_local_cart` blob.
 *
 * Same static surface as the old `LocalCartService` country methods
 * (`getCountry` / `setCountry` / `setCountryFromGeolocation` /
 * `hasExplicitCountrySelection`), including their exact prior semantics (a
 * geolocation guess always updates the stored code but only flips
 * `explicit` to true via `setCountry`), so callers migrate with an import
 * change only.
 */
const STORAGE_KEY = 'sr_country_pref';

interface CountryPref {
  countryCode: string;
  explicit: boolean;
}

const DEFAULT_PREF: CountryPref = { countryCode: 'US', explicit: false };

function read(): CountryPref {
  if (typeof window === 'undefined') return DEFAULT_PREF;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.countryCode === 'string') {
        return { countryCode: parsed.countryCode, explicit: !!parsed.explicit };
      }
    }
  } catch {
    /* corrupt value — fall through to default */
  }
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

export class CountryPreferenceService {
  static getCountry(): string {
    return read().countryCode || 'US';
  }

  static setCountry(code: string): void {
    write({ countryCode: (code || 'US').toUpperCase(), explicit: true });
  }

  /** A geolocation guess always updates the stored code but never claims to
   *  be an explicit choice — it preserves whatever `explicit` already was. */
  static setCountryFromGeolocation(code: string): void {
    const current = read();
    write({ countryCode: (code || 'US').toUpperCase(), explicit: current.explicit });
  }

  static hasExplicitCountrySelection(): boolean {
    return read().explicit;
  }
}
