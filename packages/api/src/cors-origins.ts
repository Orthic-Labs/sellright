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
import { env } from './env.js';

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
