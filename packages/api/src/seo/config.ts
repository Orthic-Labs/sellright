/**
 * SEO-1: per-store SEO configuration, resolved from `store.config.seo`
 * (JSONB — same "extra config lives in the store row" convention as
 * `pricing`/`payments`/`notifications` in admin-settings.ts). Never a
 * hardcoded domain: every storefront a store is bound to reads its own
 * `siteUrl` from here, so this module has zero per-brand knowledge.
 *
 * Shape (all optional; every field has a safe default):
 *   {
 *     "seo": {
 *       "siteUrl": "https://example.com",          // canonical origin
 *       "contactEmail": "hello@example.com",
 *       "organization": { "name": "...", "logo": "https://.../logo.png", "image": "https://.../og.jpg", "description": "...",
 *                         "telephone": "+1...", "founder": { "name": "...", "id": "https://example.com/#founder" },
 *                         "address": { "streetAddress": "...", "addressLocality": "...", "addressRegion": "...", "postalCode": "...", "addressCountry": "US" },
 *                         "sameAs": ["https://instagram.com/..."] },
 *       "searchPath": "/shop",                      // storefront search page (WebSite SearchAction `?q=`); omit for none
 *       "shipping": { "rate": "8.00", "country": "US", "handlingDays": [1, 3], "transitDays": [3, 7] },  // Product offer shippingDetails
 *       "returns": { "days": 7, "country": "US", "fees": "customer" },  // Product offer hasMerchantReturnPolicy; fees "customer" | "free"
 *       "robotsDisallow": ["checkout", "account", ...],  // path segments, no leading/trailing slash
 *       "staticPaths": ["/", "/about/", ...],       // sitemap-main entries; storefront-specific, so config-driven
 *       "productUrlPattern": "/shop/{slug}/",       // storefront PDP route (sitemap + JSON-LD); default /products/{slug}/
 *       "indexNow": { "key": "<32-hex-or-similar>" }
 *     }
 *   }
 */

import type { RobotsExtras } from './robots.js';

export const DEFAULT_ROBOTS_DISALLOW: readonly string[] = [
  'checkout',
  'account',
  'sign-in',
  'forgot-password',
  'password-reset',
  'verify',
  'verify-email-address-change',
  'track-order',
];

export const DEFAULT_STATIC_PATHS: readonly string[] = ['/'];

/** Storefront PDP route, as a path with a `{slug}` placeholder. */
export const DEFAULT_PRODUCT_URL_PATTERN = '/products/{slug}/';

/** A usable pattern is an absolute path carrying exactly the `{slug}` placeholder. */
export function isProductUrlPattern(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && v.split('{slug}').length === 2 && !/[\s?#]/.test(v);
}

/** Absolute path of a product page for this store's storefront. */
export function productPath(config: Pick<SeoConfig, 'productUrlPattern'>, slug: string): string {
  return config.productUrlPattern.replace('{slug}', encodeURIComponent(slug));
}

/** Absolute path of a collection page. Fixed for every storefront (storefront routes/collections, sitemap-collections,
 *  edge purge all build it here). */
export function collectionPath(slug: string): string {
  return `/collections/${encodeURIComponent(slug)}/`;
}

export interface SeoAddress {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string;
}

export interface SeoOrganization {
  name: string;
  logo: string | null;
  /** Social-share / brand image (absolute URL). */
  image: string | null;
  description: string | null;
  telephone: string | null;
  founder: { name: string; id: string | null } | null;
  address: SeoAddress | null;
  sameAs: string[];
}

export interface DayRange {
  min: number;
  max: number;
}

/** Offer shipping facts for Product JSON-LD (store policy, so it lives in store config, never in code). */
export interface SeoShipping {
  /** Decimal price string ("8.00"; "0.00" is free shipping). */
  rate: string;
  /** ISO 3166-1 alpha-2 destination country. */
  country: string;
  handling: DayRange | null;
  transit: DayRange | null;
}

/** Offer return policy for Product JSON-LD: a finite window, returned by mail. */
export interface SeoReturns {
  days: number;
  country: string;
  /** Who pays return shipping. */
  fees: 'customer' | 'free';
}

export interface SeoConfig {
  /** Canonical origin (scheme + host, no trailing slash), or null when unset. */
  siteUrl: string | null;
  contactEmail: string | null;
  organization: SeoOrganization;
  robotsDisallow: string[];
  staticPaths: string[];
  /** PDP route with a `{slug}` placeholder (see DEFAULT_PRODUCT_URL_PATTERN). */
  productUrlPattern: string;
  /** Storefront search page path (the WebSite SearchAction target, `?q=`), or null when the storefront has none. */
  searchPath: string | null;
  shipping: SeoShipping | null;
  returns: SeoReturns | null;
  /** IndexNow key, or null when the store hasn't configured one. */
  indexNowKey: string | null;
  /** robots.txt extras (see seo/robots.ts). Empty by default. */
  robots: RobotsExtras;
}

/** Max size of a raw robots.txt block (extra / footer). */
const ROBOTS_BLOCK_MAX = 16_384;

/** One robots.txt line: no line breaks, bounded. */
function robotsLines(v: unknown): string[] {
  return (stringArray(v) ?? []).filter((l) => !/[\r\n]/.test(l) && l.length <= 500);
}

/** A raw robots.txt block: normalized newlines, bounded, no NUL. */
function robotsBlock(v: unknown): string | null {
  if (!isNonEmptyString(v) || v.includes('\0')) return null;
  const text = v.replace(/\r\n?/g, '\n').trim();
  return text.length > 0 && text.length <= ROBOTS_BLOCK_MAX ? text : null;
}

/** IndexNow keys are hex strings, 8-128 chars per the spec. */
const INDEXNOW_KEY_RE = /^[a-f0-9]{8,128}$/i;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter(isNonEmptyString).map((x) => x.trim());
  return out.length > 0 ? out : null;
}

function optionalString(v: unknown, max = 1000): string | null {
  return isNonEmptyString(v) && v.trim().length <= max ? v.trim() : null;
}

const ADDRESS_FIELDS = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'] as const;

function addressOf(v: unknown): SeoAddress | null {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Record<string, unknown>;
  const out: SeoAddress = {};
  for (const k of ADDRESS_FIELDS) {
    const val = optionalString(raw[k], 200);
    if (val) out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function founderOf(v: unknown): SeoOrganization['founder'] {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Record<string, unknown>;
  const name = optionalString(raw.name, 200);
  return name ? { name, id: originOf(raw.id) ? optionalString(raw.id, 500) : null } : null;
}

function dayRangeOf(v: unknown): DayRange | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [min, max] = v;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 365;
  return ok(min) && ok(max) && min <= max ? { min, max } : null;
}

const COUNTRY_RE = /^[A-Za-z]{2}$/;

function shippingOf(v: unknown): SeoShipping | null {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Record<string, unknown>;
  const rate = typeof raw.rate === 'number' ? raw.rate.toFixed(2) : typeof raw.rate === 'string' ? raw.rate.trim() : '';
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(rate) || !COUNTRY_RE.test(String(raw.country))) return null;
  return {
    rate: Number(rate).toFixed(2),
    country: String(raw.country).toUpperCase(),
    handling: dayRangeOf(raw.handlingDays),
    transit: dayRangeOf(raw.transitDays),
  };
}

function returnsOf(v: unknown): SeoReturns | null {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Record<string, unknown>;
  const days = raw.days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365 || !COUNTRY_RE.test(String(raw.country))) return null;
  return { days, country: String(raw.country).toUpperCase(), fees: raw.fees === 'free' ? 'free' : 'customer' };
}

/** Normalizes an arbitrary URL string down to its origin. Returns null on any
 *  parse failure or non-http(s) scheme — a malformed config value must never
 *  crash sitemap/robots/JSON-LD generation. */
function originOf(v: unknown): string | null {
  if (!isNonEmptyString(v)) return null;
  try {
    const url = new URL(v.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function seoConfigFromStore(store: { name: string; config: unknown }): SeoConfig {
  const cfg = (store.config ?? {}) as { seo?: unknown; storefrontUrl?: unknown };
  const raw = (cfg.seo ?? {}) as Record<string, unknown>;
  const org = (raw.organization ?? {}) as Record<string, unknown>;
  const indexNow = (raw.indexNow ?? {}) as Record<string, unknown>;
  const indexNowKeyRaw = isNonEmptyString(indexNow.key) ? indexNow.key.trim() : '';

  // seo.siteUrl overrides; otherwise reuse the same store.config.storefrontUrl
  // field feeds.ts/email links already read (feeds/feed.ts::feedConfigFromStore)
  // — one canonical per-store URL, not a second field stores must remember to
  // duplicate. No env fallback here (unlike feeds' STOREFRONT_URL default):
  // an SEO surface serving many tenants must not silently point every
  // unconfigured store at the same placeholder domain.
  return {
    siteUrl: originOf(raw.siteUrl) ?? originOf(cfg.storefrontUrl),
    contactEmail: isNonEmptyString(raw.contactEmail) ? raw.contactEmail.trim() : null,
    organization: {
      name: isNonEmptyString(org.name) ? org.name.trim() : store.name,
      logo: isNonEmptyString(org.logo) ? org.logo.trim() : null,
      image: isNonEmptyString(org.image) ? org.image.trim() : null,
      description: optionalString(org.description),
      telephone: optionalString(org.telephone, 40),
      founder: founderOf(org.founder),
      address: addressOf(org.address),
      sameAs: stringArray(org.sameAs) ?? [],
    },
    robotsDisallow: stringArray(raw.robotsDisallow) ?? [...DEFAULT_ROBOTS_DISALLOW],
    staticPaths: stringArray(raw.staticPaths) ?? [...DEFAULT_STATIC_PATHS],
    productUrlPattern: isProductUrlPattern(raw.productUrlPattern) ? raw.productUrlPattern : DEFAULT_PRODUCT_URL_PATTERN,
    searchPath: isNonEmptyString(raw.searchPath) && raw.searchPath.startsWith('/') && !raw.searchPath.startsWith('//') && !/[\s?#{}]/.test(raw.searchPath) ? raw.searchPath.trim() : null,
    shipping: shippingOf(raw.shipping),
    returns: returnsOf(raw.returns),
    indexNowKey: INDEXNOW_KEY_RE.test(indexNowKeyRaw) ? indexNowKeyRaw.toLowerCase() : null,
    robots: {
      header: robotsLines(raw.robotsHeader),
      directives: robotsLines(raw.robotsDirectives),
      extra: robotsBlock(raw.robotsExtra),
      sitemaps: robotsLines(raw.robotsSitemaps).filter((p) => /^\/?[A-Za-z0-9._\/-]+$/.test(p)),
      footer: robotsBlock(raw.robotsFooter),
    },
  };
}

/** Admin-facing patch shape — every field optional, applied as a shallow
 *  merge under config.seo (see routes/admin-seo.ts::mutateSeoConfig). */
export interface SeoConfigPatch {
  siteUrl?: string | null;
  contactEmail?: string | null;
  organization?: {
    name?: string;
    logo?: string | null;
    image?: string | null;
    description?: string | null;
    telephone?: string | null;
    founder?: { name: string; id?: string } | null;
    address?: SeoAddress | null;
    sameAs?: string[];
  };
  robotsDisallow?: string[];
  staticPaths?: string[];
  productUrlPattern?: string | null;
  searchPath?: string | null;
  shipping?: Partial<{ rate: string | number; country: string; handlingDays: [number, number]; transitDays: [number, number] }> | null;
  returns?: Partial<{ days: number; country: string; fees: 'customer' | 'free' }> | null;
  indexNowKey?: string | null;
  robotsHeader?: string[];
  robotsDirectives?: string[];
  robotsExtra?: string | null;
  robotsSitemaps?: string[];
  robotsFooter?: string | null;
}
