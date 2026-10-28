/**
 * Checkout address rules (#407), shared by the storefront and the API.
 *
 * This file is kept byte-identical at `packages/storefront/src/utils/address-rules.ts` and
 * `packages/api/src/checkout/address-rules.ts` (the API parity test fails if they drift), so the
 * browser and the server accept and reject the same addresses. No imports: it must run in both.
 *
 * The rules are deliberately permissive. A rule that rejects a real address costs a sale, and the
 * carrier, not this file, is the authority on deliverability.
 */

export type RuleResult = { isValid: true } | { isValid: false; message: string };

const ok: RuleResult = { isValid: true };
const fail = (message: string): RuleResult => ({ isValid: false, message });

export const LIMITS = { name: 100, line: 200, city: 100, region: 100, postalCode: 20, phone: 32 } as const;

// C0/C1 control characters, plus the Unicode line and paragraph separators.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
// Letters and combining marks from any script, plus space, hyphen, apostrophes (straight and curly) and period.
const NAME = /^[\p{L}\p{M}](?:[\p{L}\p{M} '’‘.-]*[\p{L}\p{M}.])?$/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

const text = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

export const validatePersonName = (value: unknown, label = 'Name'): RuleResult => {
  const v = text(value);
  if (!v) return fail(`${label} is required`);
  if (v.length > LIMITS.name) return fail(`${label} is too long`);
  if (CONTROL.test(v) || !NAME.test(v)) return fail(`${label} can use letters, spaces, hyphens, apostrophes and periods`);
  return ok;
};

/** Street lines and city: any characters a real address uses (`#`, `/`, `&`, digits, any script). */
export const validateAddressLine = (value: unknown, label: string, required = true, max: number = LIMITS.line): RuleResult => {
  const v = text(value);
  if (!v) return required ? fail(`${label} is required`) : ok;
  if (v.length > max) return fail(`${label} is too long`);
  if (CONTROL.test(v)) return fail(`${label} contains characters that can't be printed on a label`);
  if (!HAS_LETTER_OR_DIGIT.test(v)) return fail(`Please enter a valid ${label.toLowerCase()}`);
  return ok;
};

export const validateCity = (value: unknown): RuleResult => validateAddressLine(value, 'City', true, LIMITS.city);

// Countries with no postal code system (or none in general use). Postcode is optional there; everywhere else it is required.
export const NO_POSTCODE_COUNTRIES: ReadonlySet<string> = new Set([
  'AE', 'AG', 'AN', 'AO', 'AW', 'BF', 'BI', 'BJ', 'BO', 'BS', 'BW', 'BZ', 'CD', 'CF', 'CG', 'CI', 'CK', 'CM', 'DJ', 'DM',
  'ER', 'FJ', 'GA', 'GD', 'GH', 'GM', 'GQ', 'GY', 'HK', 'IE', 'JM', 'KE', 'KI', 'KM', 'KN', 'KP', 'LC', 'ML', 'MO', 'MR',
  'MW', 'NR', 'NU', 'QA', 'RW', 'SB', 'SC', 'SL', 'SO', 'SR', 'ST', 'SY', 'TD', 'TF', 'TG', 'TK', 'TL', 'TO', 'TT', 'TV',
  'UG', 'VU', 'YE', 'ZW',
]);

// Well-known formats only. Anything else gets the loose check below.
const POSTCODE_PATTERNS: Record<string, { re: RegExp; example: string }> = {
  US: { re: /^\d{5}(?:[- ]?\d{4})?$/, example: '10001 or 10001-1234' },
  CA: { re: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/i, example: 'K1A 0B1' },
  GB: { re: /^(?:GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/i, example: 'SW1A 1AA' },
  AU: { re: /^\d{4}$/, example: '2000' },
  IN: { re: /^[1-9]\d{2} ?\d{3}$/, example: '400001' },
  DE: { re: /^\d{5}$/, example: '10115' },
  FR: { re: /^\d{5}$/, example: '75001' },
  NL: { re: /^\d{4} ?[A-Z]{2}$/i, example: '1012 AB' },
  PT: { re: /^\d{4}-\d{3}$/, example: '1000-001' },
};
const LOOSE_POSTCODE = /^[A-Z0-9](?:[A-Z0-9 -]{0,10}[A-Z0-9])?$/i;

export const postcodeRequired = (country: string): boolean => !NO_POSTCODE_COUNTRIES.has(country.toUpperCase());

export const postcodeLabel = (country: string): string => {
  switch (country.toUpperCase()) {
    case 'US': return 'ZIP code';
    case 'GB': return 'Postcode';
    case 'IN': return 'PIN code';
    default: return 'Postal code';
  }
};

/** The label mid-sentence: "postal code", but "ZIP code" and "PIN code" keep their capitals. */
export const postcodeNoun = (country: string): string => {
  const label = postcodeLabel(country);
  return /^[A-Z]{2}/.test(label) ? label : label.toLowerCase();
};

export const validatePostcode = (value: unknown, country: string): RuleResult => {
  const c = country.toUpperCase();
  const v = text(value);
  const label = postcodeLabel(c);
  const noun = postcodeNoun(c);
  if (!v) return postcodeRequired(c) ? fail(`${label} is required`) : ok;
  if (v.length > LIMITS.postalCode) return fail(`${label} is too long`);
  const known = POSTCODE_PATTERNS[c];
  if (known) return known.re.test(v) ? ok : fail(`Please enter a valid ${noun} (e.g. ${known.example})`);
  return LOOSE_POSTCODE.test(v) ? ok : fail(`Please enter a valid ${noun}`);
};

// Countries whose carriers need a state/province/region on the label. Optional everywhere else.
export const REGION_REQUIRED_COUNTRIES: ReadonlySet<string> = new Set(['US', 'CA', 'AU', 'IN', 'BR', 'MX', 'CN', 'JP']);

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z]/g, '');

const US_REGIONS: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  AS: 'American Samoa', GU: 'Guam', MP: 'Northern Mariana Islands', PR: 'Puerto Rico', VI: 'US Virgin Islands',
  UM: 'US Minor Outlying Islands', AA: 'Armed Forces Americas', AE: 'Armed Forces Europe', AP: 'Armed Forces Pacific',
};
const CA_REGIONS: Record<string, string> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Québec', SK: 'Saskatchewan', YT: 'Yukon',
};
const AU_REGIONS: Record<string, string> = {
  ACT: 'Australian Capital Territory', NSW: 'New South Wales', NT: 'Northern Territory', QLD: 'Queensland',
  SA: 'South Australia', TAS: 'Tasmania', VIC: 'Victoria', WA: 'Western Australia',
};
const REGION_LISTS: Record<string, { regions: Record<string, string>; name: string; example: string }> = {
  US: { regions: US_REGIONS, name: 'US state', example: '"CA" or "California"' },
  CA: { regions: CA_REGIONS, name: 'Canadian province', example: '"ON" or "Ontario"' },
  AU: { regions: AU_REGIONS, name: 'Australian state', example: '"NSW" or "New South Wales"' },
};
const REGION_INDEX: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(REGION_LISTS).map(([c, { regions }]) => [
    c,
    new Set(Object.entries(regions).flatMap(([code, name]) => [fold(code), fold(name)])
      .concat(c === 'US' ? [fold('Washington DC'), fold('Washington D.C.')] : [])),
  ]),
);

export const regionRequired = (country: string): boolean => REGION_REQUIRED_COUNTRIES.has(country.toUpperCase());

export const validateRegion = (value: unknown, country: string, label = 'State/Province'): RuleResult => {
  const c = country.toUpperCase();
  const v = text(value);
  if (!v) return regionRequired(c) ? fail(`${label} is required`) : ok;
  if (v.length > LIMITS.region) return fail(`${label} is too long`);
  if (CONTROL.test(v)) return fail(`${label} contains characters that can't be printed on a label`);
  const list = REGION_LISTS[c];
  if (list && !REGION_INDEX[c]!.has(fold(v))) return fail(`Please enter a valid ${list.name} (e.g. ${list.example})`);
  return ok;
};

/** Phone is optional; when given, digits plus common formatting, 6 to 15 digits (E.164 max). */
export const validatePhoneLoose = (value: unknown, required = false): RuleResult => {
  const v = text(value);
  if (!v) return required ? fail('Phone number is required') : ok;
  if (v.length > LIMITS.phone || !/^\+?[\d\s()./-]+(?:\s*(?:x|ext\.?)\s*\d{1,6})?$/i.test(v)) {
    return fail('Use digits only (spaces, +, - and brackets are fine)');
  }
  const digits = v.replace(/(?:x|ext\.?)\s*\d+$/i, '').replace(/\D/g, '');
  if (digits.length < 6) return fail('Phone number is too short');
  if (digits.length > 15) return fail('Phone number is too long');
  return ok;
};

/** The canonical (API) address shape. The storefront's streetLine1/countryCode shape is mapped by the caller. */
export type AddressInput = {
  fullName?: unknown; line1?: unknown; line2?: unknown; city?: unknown;
  province?: unknown; postalCode?: unknown; country?: unknown; phone?: unknown;
};

/** Field-level errors for a whole address; an empty object means valid. */
export const addressFieldErrors = (a: AddressInput, opts: { requireName?: boolean } = {}): Record<string, string> => {
  const errors: Record<string, string> = {};
  const put = (field: string, r: RuleResult) => { if (!r.isValid) errors[field] = r.message; };
  const country = text(a.country).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) errors.country = 'Country is required';
  if (opts.requireName || text(a.fullName)) put('fullName', validatePersonName(a.fullName, 'Name'));
  put('line1', validateAddressLine(a.line1, 'Street address'));
  put('line2', validateAddressLine(a.line2, 'Apartment, suite, etc.', false));
  put('city', validateCity(a.city));
  if (!errors.country) {
    put('province', validateRegion(a.province, country));
    put('postalCode', validatePostcode(a.postalCode, country));
  }
  put('phone', validatePhoneLoose(a.phone));
  return errors;
};
