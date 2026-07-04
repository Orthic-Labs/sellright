import { pool } from './db/client.js';
import { env } from './env.js';

export interface StoreCtx {
  id: string;
  slug: string;
  name: string;
  currency: string;
  taxRate: number;
  taxInclusive: boolean;
  shippingTaxable: boolean;
  config: unknown | null;
}

/**
 * PERF-2: in-process TTL cache for resolveStore / resolveStoreByHost.
 *
 * Hot path: every request resolves the store before RLS-scoped work runs, so the
 * two functions below hit Postgres on EVERY call. With a CDN/edge in front, the
 * per-store cache hit ratio is ~1 — same slug or same host keeps returning the
 * same StoreCtx until config changes.
 *
 * - Plain JS Map keyed by slug / host. No extra dep.
 * - 60s TTL: long enough to absorb a request burst, short enough that any drift
 *   between cache and DB resolves inside a minute even if an invalidate call
 *   is missed (admin-only paths; out of band).
 * - Cap 1000 entries per map (see MAX_ENTRIES). eviction is lazy on read
 *   (expired), and opportunistic on write (when size > MAX_ENTRIES we drop the
 *   oldest by insertion order — JS Map preserves insertion order; no separate
 *   timestamp walk needed for the cap path).
 * - Per-process only — matches the in-proc login throttle (auth/rate-limit.ts).
 *   When running N>=2 API instances, move to Redis via SCALE-1.
 */
const CACHE_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 1000;

interface CacheEntry<T> { value: T; expiresAt: number; }

const slugCache = new Map<string, CacheEntry<StoreCtx>>();
const hostCache = new Map<string, CacheEntry<StoreCtx>>();

function readCache<T>(m: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const e = m.get(key);
  if (!e) return undefined;
  if (e.expiresAt <= Date.now()) {
    m.delete(key);
    return undefined;
  }
  return e.value;
}

function writeCache<T>(m: Map<string, CacheEntry<T>>, key: string, value: T): void {
  m.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  // Opportunistic cap: if we just exceeded MAX_ENTRIES, drop from the oldest end
  // (insertion order is the iteration order on JS Map) until back at limit.
  if (m.size > MAX_ENTRIES) {
    const drop = m.size - MAX_ENTRIES;
    let removed = 0;
    for (const k of m.keys()) {
      if (removed >= drop) break;
      m.delete(k);
      removed++;
    }
  }
}

/**
 * Drop cached entries for a slug and/or host. Called by settings-save handlers
 * after they mutate store config (admin-settings.ts) so the next request sees
 * fresh values instead of the stale 60s TTL.
 *
 * - `invalidateStoreCache('damned')` → drop the slug entry AND scan all host
 *   entries' config.hostnames for a match against this slug. A slug's
 *   hostnames live inside the store.config JSONB blob the settings endpoints
 *   can edit, and a positive host match invalidates the host cache too —
 *   otherwise a hostname change would leave a 60s window where host routing
 *   used the stale hostnames.
 * - `invalidateStoreCache(undefined, 'foo.example')` → drop just that host.
 * - `invalidateStoreCache()` → flush everything (process-wide flush; tests).
 */
export function invalidateStoreCache(slug?: string, host?: string): void {
  if (slug === undefined && host === undefined) {
    slugCache.clear();
    hostCache.clear();
    return;
  }
  if (slug !== undefined) {
    slugCache.delete(slug);
    // Drop any host cache entry whose cached store matches this slug: its
    // config (which holds the hostnames) just changed.
    for (const [k, v] of hostCache) {
      if (v.value.slug === slug) hostCache.delete(k);
    }
  }
  if (host !== undefined) hostCache.delete(host);
}

/** Test-only: peek at current cache sizes. Not part of the public surface. */
export function _cacheSizeForTest(): { slug: number; host: number } {
  return { slug: slugCache.size, host: hostCache.size };
}

/** Slug shape: lowercase, 1-64 chars, alnum + dash/underscore, must start+end alnum. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

/** Throws a 404 (HttpError) for invalid or unknown slugs. Use this in route
 *  handlers so callers see 404 instead of a thrown 500. WP1.6. */
export function assertValidSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new StoreSlugError('invalid slug format');
  return slug;
}

export class StoreSlugError extends Error {
  readonly httpStatus = 404 as const;
  constructor(message: string) { super(message); this.name = 'StoreSlugError'; }
}

/** Thrown when a production request's Host doesn't match any store and no
 *  explicit x-store-slug was given — the request must 404, NOT silently fall
 *  back to the dev default store (OPS-1: a CDN stripping custom headers would
 *  otherwise route every request to 'damned'). */
export class HostRoutingError extends Error {
  readonly httpStatus = 404 as const;
  constructor(message: string) { super(message); this.name = 'HostRoutingError'; }
}

/**
 * Resolve a store from the registry (the `store` table is not RLS'd — it's the
 * tenant registry). In production this maps an incoming host/subdomain to a
 * store; in dev we accept an `x-store-slug` header. After resolving, all data
 * access runs inside withStore(store.id) so RLS confines it to that store.
 * Throws StoreSlugError (404) on invalid or unknown slugs. WP1.6.
 */
export async function resolveStore(slug: string): Promise<StoreCtx> {
  assertValidSlug(slug);
  const cached = readCache(slugCache, slug);
  if (cached) return cached;
  const r = await pool.query<StoreCtx>(
    'SELECT id, slug, name, currency, tax_rate AS "taxRate", tax_inclusive AS "taxInclusive", shipping_taxable AS "shippingTaxable", config FROM store WHERE slug = $1 LIMIT 1',
    [slug],
  );
  if (!r.rows[0]) throw new StoreSlugError(`unknown store: ${slug}`);
  writeCache(slugCache, slug, r.rows[0]);
  return r.rows[0];
}

export const DEV_DEFAULT_STORE = 'damned';

/**
 * Normalize a Host / X-Forwarded-Host header value: strip a trailing :port,
 * lowercase, trim. Returns null for empty/missing input. Pure + DB-free so
 * it's unit-testable without a database (OPS-1).
 */
export function normalizeHost(rawHost: string | undefined | null): string | null {
  const host = rawHost?.split(',')[0]?.trim().split(':')[0]?.trim().toLowerCase();
  return host && host.length > 0 ? host : null;
}

/**
 * Pure host-matching logic against a store's declared hostname list
 * (store.config.hostnames — see resolveStoreByHost). A host matches an entry
 * either exactly or as a subdomain of it, mirroring isAllowedRedirectHost's
 * suffix-match semantics. DB-free and unit-testable (OPS-1).
 */
export function hostMatchesAny(host: string, hostnames: readonly string[]): boolean {
  const needle = host.toLowerCase();
  return hostnames.some((h) => {
    const suffix = h.trim().toLowerCase();
    if (!suffix) return false;
    return needle === suffix || needle.endsWith(`.${suffix}`);
  });
}

function hostnamesFromConfig(config: unknown): string[] {
  if (!config || typeof config !== 'object') return [];
  const raw = (config as Record<string, unknown>).hostnames;
  if (!Array.isArray(raw)) return [];
  return raw.filter((h): h is string => typeof h === 'string' && h.trim().length > 0);
}

/**
 * Resolve a store by incoming Host header, scanning store.config.hostnames
 * (JSONB — no dedicated table; see docs/runbooks/migrations.md discussion in
 * OPS-1). Returns null when no store declares this host — callers decide the
 * fallback (dev default vs production 404).
 *
 * `store` is the un-RLS'd tenant registry (see rls-tables.test.ts EXEMPT set),
 * so this scans it directly via the unscoped pool — no store context exists
 * yet at this point in the request lifecycle.
 */
export async function resolveStoreByHost(host: string): Promise<StoreCtx | null> {
  const cached = readCache(hostCache, host);
  if (cached) return cached;
  const r = await pool.query<StoreCtx>(
    'SELECT id, slug, name, currency, tax_rate AS "taxRate", tax_inclusive AS "taxInclusive", shipping_taxable AS "shippingTaxable", config FROM store',
  );
  for (const row of r.rows) {
    if (hostMatchesAny(host, hostnamesFromConfig(row.config))) {
      writeCache(hostCache, host, row);
      return row;
    }
  }
  // Don't cache negative lookups — config.hostnames changes invalidate the
  // hostCache via the slug path on next settings save, but a stale "no match"
  // entry would defeat that. Negative cache is bounded by traffic to the
  // unmatched host, which is naturally a small set.
  return null;
}

/**
 * Resolve a store for an incoming request, given the caller-supplied
 * x-store-slug header (or undefined) and Host/X-Forwarded-Host (or undefined).
 *
 * Precedence (OPS-1):
 *   1. explicit x-store-slug header — dev/admin tooling that sets it deliberately.
 *   2. Host (or X-Forwarded-Host, preferred when set — this deployment sits
 *      behind a CDN/proxy that terminates TLS and forwards the original host)
 *      matched against store.config.hostnames.
 *   3. In non-production: DEV_DEFAULT_STORE ('damned'), so local dev and CI
 *      keep working without seeding hostnames.
 *   4. In production: throws HostRoutingError (404) — NEVER silently serve the
 *      dev default. A CDN that strips custom headers must not turn every
 *      request into a 'damned' request.
 *
 * `isProduction` defaults to reading env.NODE_ENV but is injectable so DB
 * integration tests can exercise both branches without vi.mock'ing the env
 * module (which would force a vi.resetModules() and leak a fresh pg.Pool per
 * re-import of db/client.js).
 */
export async function resolveStoreForRequest(
  opts: { storeSlugHeader?: string; host?: string; forwardedHost?: string },
  isProduction: boolean = env.NODE_ENV === 'production',
): Promise<StoreCtx> {
  if (opts.storeSlugHeader) return resolveStore(opts.storeSlugHeader);

  const host = normalizeHost(opts.forwardedHost) ?? normalizeHost(opts.host);
  if (host) {
    const byHost = await resolveStoreByHost(host);
    if (byHost) return byHost;
  }

  if (!isProduction) return resolveStore(DEV_DEFAULT_STORE);

  throw new HostRoutingError(host ? `no store configured for host: ${host}` : 'missing Host header');
}
