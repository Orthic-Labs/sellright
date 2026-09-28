/**
 * Sliding-window throttle for guest order tracking (GET /v1/shop/track).
 * Storage is pluggable (SELLRIGHT-ISSUES P1 — see auth/rate-limit-backend.ts):
 * RATE_LIMIT_BACKEND=postgres (default) shares state across every API
 * process; =memory is an explicit single-process opt-out. Matches the source
 * store's ten-attempt hourly window.
 */
import { rateLimitBackend } from '../auth/rate-limit-backend.js';

const WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const BUCKET = 'tracking';

/** Checks AND records in one call — a successful (non-throttled) call always
 *  consumes one attempt, matching the previous atomic check-and-record
 *  behavior. Returns 0 when allowed (and consumed), else retryAfterSeconds. */
export async function trackingRetryAfter(key: string): Promise<number> {
  return rateLimitBackend().consume(BUCKET, key, WINDOW_MS, MAX_ATTEMPTS);
}

export async function clearTrackingAttempts(key: string): Promise<void> {
  await rateLimitBackend().clear(BUCKET, key);
}
