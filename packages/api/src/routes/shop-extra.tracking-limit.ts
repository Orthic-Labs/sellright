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

/** Throttle key for one guest-tracking lookup: store + client IP + order code — never the email, so rotating
 *  email guesses against one order shares a single budget (the previous platform's order-tracking.service.ts `getClientKey`).
 *  The code is normalised the way the lookup accepts it ('#1001' = '1001', case-insensitive) so varying its
 *  spelling cannot mint a fresh budget. */
export function trackingKey(storeId: string, ip: string, code: string): string {
  return JSON.stringify([storeId, ip, code.trim().replace(/^#/, '').toLowerCase().slice(0, 100)]);
}

/** Checks AND records in one call — a successful (non-throttled) call always
 *  consumes one attempt, matching the previous atomic check-and-record
 *  behavior. Returns 0 when allowed (and consumed), else retryAfterSeconds. */
export async function trackingRetryAfter(key: string): Promise<number> {
  return rateLimitBackend().consume(BUCKET, key, WINDOW_MS, MAX_ATTEMPTS);
}

export async function clearTrackingAttempts(key: string): Promise<void> {
  await rateLimitBackend().clear(BUCKET, key);
}
