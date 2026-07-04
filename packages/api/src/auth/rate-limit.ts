/**
 * In-memory sliding-window login throttle (admin + customer). Blocks brute-force
 * / credential-stuffing without external infra. Per-process — fine for a single
 * instance; move the store to Redis when running multiple API instances.
 *
 * Keyed by ip+identifier. Failures count; a successful login clears the key.
 */
import { env } from '../env.js';
const WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_FAILURES = 8;

interface Entry { fails: number[]; }
const store = new Map<string, Entry>();

function prune(e: Entry, now: number): void {
  e.fails = e.fails.filter((t) => now - t < WINDOW_MS);
}

/** Throw-free check: returns retryAfterSeconds>0 if currently locked out. */
export function loginRetryAfter(ip: string, identifier: string): number {
  const key = `${ip}|${identifier.toLowerCase()}`;
  const e = store.get(key);
  if (!e) return 0;
  const now = Date.now();
  prune(e, now);
  if (e.fails.length < MAX_FAILURES) return 0;
  const oldest = e.fails[0]!;
  return Math.ceil((WINDOW_MS - (now - oldest)) / 1000);
}

export function recordLoginFailure(ip: string, identifier: string): void {
  const key = `${ip}|${identifier.toLowerCase()}`;
  const e = store.get(key) ?? { fails: [] };
  const now = Date.now();
  prune(e, now);
  e.fails.push(now);
  store.set(key, e);
  // opportunistic cleanup so the map can't grow unbounded
  if (store.size > 5000) for (const [k, v] of store) { prune(v, now); if (!v.fails.length) store.delete(k); }
}

export function clearLoginAttempts(ip: string, identifier: string): void {
  store.delete(`${ip}|${identifier.toLowerCase()}`);
}

/**
 * Pure decision logic for client-IP resolution, unit-testable without a Hono
 * context. `cf-connecting-ip` is ONLY trusted when the deployment is actually
 * behind Cloudflare's edge (`behindCloudflare: true`) — otherwise it is a
 * client-forgeable header like any other and honoring it unconditionally lets
 * anyone spoof a distinct IP per request and defeat the login rate limiter.
 * When not behind Cloudflare, fall back to `trustedHeader` (set by a proxy the
 * deployment actually controls, e.g. our own nginx's X-Real-IP) then the raw
 * socket address. X-Forwarded-For is INTENTIONALLY never read anywhere in this
 * chain because it's trivially forgeable and multi-hop. See WP1.4 / SEC-5.
 */
export function pickClientIp(
  headers: { get: (k: string) => string | undefined },
  opts: { behindCloudflare: boolean; trustedHeader: string; remoteAddr?: string },
): string {
  if (opts.behindCloudflare) {
    const cf = headers.get('cf-connecting-ip');
    if (cf) return cf;
  }
  return headers.get(opts.trustedHeader) ?? opts.remoteAddr ?? 'unknown';
}

/** Best-effort client IP from proxy headers (Cloudflare / nginx) or fallback.
 *  See {@link pickClientIp} for the trust rules. */
export function clientIp(c: { req: { header: (k: string) => string | undefined }; env?: { remoteAddr?: string } }): string {
  return pickClientIp(
    { get: (k) => c.req.header(k) },
    {
      behindCloudflare: env.BEHIND_CLOUDFLARE === '1',
      trustedHeader: env.TRUSTED_PROXY_HEADER,
      remoteAddr: c.env?.remoteAddr,
    },
  );
}
