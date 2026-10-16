/**
 * OPS-1: per-store CORS origin allowlist.
 *
 * The API is multi-tenant behind one deployment (see store-context.ts) — there
 * is no single "the storefront origin" to hardcode. An origin is allowed when
 * its hostname matches a configured store host (store.config.hostnames, the
 * same registry host->store routing reads) or a small always-on localhost
 * allowlist for local dev. No wildcard-with-credentials: an unmatched origin
 * is rejected outright, never widened to '*'.
 */
import { hostMatchesAny, normalizeHost, resolveStoreByHost } from './store-context.js';
import { env, adminPublicUrl } from './env.js';

/** Always allowed in non-production, regardless of store.config — local dev
 *  and CI need CORS to work before any store has hostnames configured. */
const DEV_LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/**
 * Pure hostname check against an explicit allowlist — DB-free and
 * unit-testable, mirroring isAllowedRedirectHost. `isDev` gates the
 * DEV_LOCAL_HOSTS allowance so production never grants it. Composed into
 * isAllowedCorsOrigin below, which supplies the DB-sourced hostnames + the
 * live env.NODE_ENV check.
 */
export function isAllowedOriginHost(host: string, storeHostnames: readonly string[], isDev: boolean): boolean {
  if (isDev && DEV_LOCAL_HOSTS.includes(host)) return true;
  return hostMatchesAny(host, storeHostnames);
}

/**
 * P2 (security audit 2026-10-15): /v1/admin is credentialed, so its CORS allowlist is EXACT origins only — the admin
 * SPA's own origin (ADMIN_PUBLIC_URL / STOREFRONT_URL + /admin) plus ADMIN_CORS_ORIGINS. Scheme, host and port must
 * all match; no suffix, subdomain, scheme or port wildcarding (the store-hostname match below is for the shop API).
 */
export function isAllowedAdminCorsOrigin(origin: string | undefined, allowed: readonly string[] = adminCorsOrigins()): boolean {
  if (!origin) return false;
  let o: string;
  try { o = new URL(origin).origin; } catch { return false; }
  if (o === 'null' || o !== origin.replace(/\/+$/, '')) return false; // reject anything that is not a bare origin
  return allowed.includes(o);
}

export function adminCorsOrigins(): string[] {
  const out = new Set<string>();
  try { out.add(new URL(adminPublicUrl()).origin); } catch { /* invalid config: no implicit origin */ }
  for (const raw of (env.ADMIN_CORS_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    try { out.add(new URL(raw).origin); } catch { /* ignore malformed entries */ }
  }
  return [...out];
}

/**
 * Full check for the CORS middleware: parses the Origin header and matches its
 * hostname against every store's config.hostnames (via resolveStoreByHost,
 * which already does the scan+match in one query) plus the dev-local
 * allowance (isAllowedOriginHost). Returns false for a missing/malformed
 * Origin (same-origin requests don't send one; the caller in app.ts only
 * invokes this when an Origin header is present).
 */
export async function isAllowedCorsOrigin(origin: string | undefined): Promise<boolean> {
  if (!origin) return false;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  const host = normalizeHost(hostname);
  if (!host) return false;

  const isDev = env.NODE_ENV !== 'production';
  if (isAllowedOriginHost(host, [], isDev)) return true; // dev-local allowance only, no store list yet

  const store = await resolveStoreByHost(host);
  return store !== null;
}
