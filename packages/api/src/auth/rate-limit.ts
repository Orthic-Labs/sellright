/**
 * In-memory sliding-window throttle for auth failures and high-risk shopper
 * actions. Per-process — appropriate for a single API instance; move the state
 * to Redis (or another shared limiter) before running multiple API instances.
 *
 * Login/auth buckets remain failure-counted: callers explicitly record a failed
 * authentication and a successful login clears the key. Checkout/payment
 * buckets are attempt-counted because those routes do not have an equivalent
 * authentication-failure signal and every request is abuse-relevant.
 */
import { env } from '../env.js';
const WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_FAILURES = 8;

interface Entry { fails: number[]; }
const store = new Map<string, Entry>();

function keyFor(ip: string, identifier: string): string {
  return `${ip}|${identifier.toLowerCase()}`;
}

function prune(e: Entry, now: number): void {
  e.fails = e.fails.filter((t) => now - t < WINDOW_MS);
}

function retryAfterFor(e: Entry, now: number): number {
  if (e.fails.length < MAX_FAILURES) return 0;
  const oldest = e.fails[0]!;
  return Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
}

function cleanup(now: number): void {
  // Opportunistic cleanup so the map cannot grow unbounded on a long-lived
  // process receiving one-off identifiers/IPs.
  if (store.size <= 5000) return;
  for (const [k, v] of store) {
    prune(v, now);
    if (!v.fails.length) store.delete(k);
  }
}

/**
 * Consume one request from an attempt-counted bucket. Returns retry-after
 * seconds when the request must be rejected; otherwise records the attempt and
 * returns 0. Exactly MAX_FAILURES attempts are allowed in a window.
 */
export function attemptRetryAfter(ip: string, identifier: string): number {
  const key = keyFor(ip, identifier);
  const e = store.get(key) ?? { fails: [] };
  const now = Date.now();
  prune(e, now);
  const retry = retryAfterFor(e, now);
  if (retry > 0) return retry;
  e.fails.push(now);
  store.set(key, e);
  cleanup(now);
  return 0;
}

/**
 * Throw-free check used by the existing auth call sites. Login/auth identifiers
 * are check-only and are incremented by recordLoginFailure(). Historical
 * checkout/pay call sites also use this function; recognize those explicit
 * namespaces and consume an attempt so their limiter cannot remain inert.
 */
export function loginRetryAfter(ip: string, identifier: string): number {
  if (identifier.startsWith('checkout:') || identifier.startsWith('pay:')) {
    return attemptRetryAfter(ip, identifier);
  }

  const e = store.get(keyFor(ip, identifier));
  if (!e) return 0;
  const now = Date.now();
  prune(e, now);
  return retryAfterFor(e, now);
}

export function recordLoginFailure(ip: string, identifier: string): void {
  const key = keyFor(ip, identifier);
  const e = store.get(key) ?? { fails: [] };
  const now = Date.now();
  prune(e, now);
  e.fails.push(now);
  store.set(key, e);
  cleanup(now);
}

export function clearLoginAttempts(ip: string, identifier: string): void {
  store.delete(keyFor(ip, identifier));
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
