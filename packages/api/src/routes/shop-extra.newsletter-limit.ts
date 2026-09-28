/**
 * Sliding-window throttle for the public, unauthenticated newsletter signup
 * endpoint (POST /v1/shop/newsletter-signup). Storage is pluggable
 * (SELLRIGHT-ISSUES P1 — see auth/rate-limit-backend.ts): RATE_LIMIT_BACKEND
 * =postgres (default) shares state across every API process; =memory is an
 * explicit single-process opt-out. Separate bucket from auth/rate-limit.ts's
 * login throttle because that module's threshold (MAX_FAILURES = 8) is a
 * shared constant used by login/register/pay/check-email — changing it would
 * change behavior for those routes too. This is a small, dedicated
 * 5-attempts/15-min bucket keyed by IP, counting every attempt (not just
 * failures) since every unauthenticated POST here is an outbound-fetch
 * amplification opportunity, not just a "bad credential".
 */
import { rateLimitBackend } from '../auth/rate-limit-backend.js';

const WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_ATTEMPTS = 5;
const BUCKET = 'newsletter';

/** Throw-free check: returns retryAfterSeconds>0 if currently rate-limited. */
export async function newsletterRetryAfter(ip: string): Promise<number> {
  return rateLimitBackend().check(BUCKET, ip, WINDOW_MS, MAX_ATTEMPTS);
}

export async function recordNewsletterAttempt(ip: string): Promise<void> {
  await rateLimitBackend().recordFailure(BUCKET, ip, WINDOW_MS);
}
