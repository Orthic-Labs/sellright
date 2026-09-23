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
 *       "organization": { "name": "...", "logo": "https://.../logo.png", "sameAs": ["https://instagram.com/..."] },
 *       "robotsDisallow": ["checkout", "account", ...],  // path segments, no leading/trailing slash
 *       "staticPaths": ["/", "/about/", ...],       // sitemap-main entries; storefront-specific, so config-driven
 *       "indexNow": { "key": "<32-hex-or-similar>" }
 *     }
 *   }
 */

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

export interface SeoOrganization {
  name: string;
  logo: string | null;
  sameAs: string[];
}

export interface SeoConfig {
  /** Canonical origin (scheme + host, no trailing slash), or null when unset. */
  siteUrl: string | null;
  contactEmail: string | null;
  organization: SeoOrganization;
  robotsDisallow: string[];
  staticPaths: string[];
  /** IndexNow key, or null when the store hasn't configured one. */
  indexNowKey: string | null;
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
      sameAs: stringArray(org.sameAs) ?? [],
    },
    robotsDisallow: stringArray(raw.robotsDisallow) ?? [...DEFAULT_ROBOTS_DISALLOW],
    staticPaths: stringArray(raw.staticPaths) ?? [...DEFAULT_STATIC_PATHS],
    indexNowKey: INDEXNOW_KEY_RE.test(indexNowKeyRaw) ? indexNowKeyRaw.toLowerCase() : null,
  };
}

/** Admin-facing patch shape — every field optional, applied as a shallow
 *  merge under config.seo (see routes/admin-seo.ts::mutateSeoConfig). */
export interface SeoConfigPatch {
  siteUrl?: string | null;
  contactEmail?: string | null;
  organization?: Partial<SeoOrganization>;
  robotsDisallow?: string[];
  staticPaths?: string[];
  indexNowKey?: string | null;
}
