/**
 * Sliding-window throttle for auth failures and high-risk shopper actions.
 * Storage is pluggable (SELLRIGHT-ISSUES P1) — see rate-limit-backend.ts:
 * RATE_LIMIT_BACKEND=postgres (default) shares this bucket's state across
 * every API process; RATE_LIMIT_BACKEND=memory is an explicit single-process
 * opt-out. Every function here is now async because of that — all existing
 * callers already run inside an async request handler, so this only meant
 * adding `await` at each call site, not restructuring them.
 *
 * Login/auth buckets remain failure-counted: callers explicitly record a failed
 * authentication and a successful login clears the key. Checkout/payment
 * buckets are attempt-counted because those routes do not have an equivalent
 * authentication-failure signal and every request is abuse-relevant.
 */
import { env } from '../env.js';
import { rateLimitBackend } from './rate-limit-backend.js';

const WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_FAILURES = 8;
const BUCKET = 'auth';

function keyFor(ip: string, identifier: string): string {
  return `${ip}|${identifier.toLowerCase()}`;
}

/**
 * Consume one request from an attempt-counted bucket. Returns retry-after
 * seconds when the request must be rejected; otherwise records the attempt and
 * returns 0. Exactly MAX_FAILURES attempts are allowed in a window.
 */
export async function attemptRetryAfter(ip: string, identifier: string): Promise<number> {
  return rateLimitBackend().consume(BUCKET, keyFor(ip, identifier), WINDOW_MS, MAX_FAILURES);
}

/**
 * Throw-free check used by the existing auth call sites. Login/auth identifiers
 * are check-only and are incremented by recordLoginFailure(). Historical
 * checkout/pay call sites also use this function; recognize those explicit
 * namespaces and consume an attempt so their limiter cannot remain inert.
 */
export async function loginRetryAfter(ip: string, identifier: string): Promise<number> {
  if (identifier.startsWith('checkout:') || identifier.startsWith('pay:')) {
    return attemptRetryAfter(ip, identifier);
  }
  return rateLimitBackend().check(BUCKET, keyFor(ip, identifier), WINDOW_MS, MAX_FAILURES);
}

export async function recordLoginFailure(ip: string, identifier: string): Promise<void> {
  await rateLimitBackend().recordFailure(BUCKET, keyFor(ip, identifier), WINDOW_MS);
}

export async function clearLoginAttempts(ip: string, identifier: string): Promise<void> {
  await rateLimitBackend().clear(BUCKET, keyFor(ip, identifier));
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
