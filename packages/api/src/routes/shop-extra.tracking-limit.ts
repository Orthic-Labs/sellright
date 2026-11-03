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

// Security audit 2026-11-02 (guest tracking). The per-(IP, order code) budget above gives every distinct code a fresh
// allowance, so one IP could sweep sequential codes against a known email. Two more budgets close that:
//   - an aggregate per-(store, IP) budget across ALL codes (every lookup counts, hit or miss);
//   - a per-(store, IP, email) FAILURE budget: only misses count, and a success clears it, so a customer with the
//     right code is never locked out by someone else's guesses (the key includes the IP).
const AGG_BUCKET = 'tracking-ip';
const AGG_MAX_ATTEMPTS = 30;
const EMAIL_BUCKET = 'tracking-email-fail';
const EMAIL_MAX_FAILURES = 5;

export function trackingIpKey(storeId: string, ip: string): string {
  return JSON.stringify([storeId, ip]);
}

export function trackingEmailKey(storeId: string, ip: string, email: string): string {
  return JSON.stringify([storeId, ip, email.trim().toLowerCase().slice(0, 254)]);
}

/** Consumes one attempt from the per-IP aggregate budget. 0 = allowed, else retryAfterSeconds. */
export async function trackingIpRetryAfter(key: string): Promise<number> {
  return rateLimitBackend().consume(AGG_BUCKET, key, WINDOW_MS, AGG_MAX_ATTEMPTS);
}

/** Reports (without recording) whether this (store, IP, email) has used up its failure budget. */
export async function trackingEmailFailureRetryAfter(key: string): Promise<number> {
  return rateLimitBackend().check(EMAIL_BUCKET, key, WINDOW_MS, EMAIL_MAX_FAILURES);
}

export async function recordTrackingEmailFailure(key: string): Promise<void> {
  await rateLimitBackend().recordFailure(EMAIL_BUCKET, key, WINDOW_MS);
}

export async function clearTrackingEmailFailures(key: string): Promise<void> {
  await rateLimitBackend().clear(EMAIL_BUCKET, key);
}

/**
 * What a guest who proved only code + email may see of the shipping address: city, region and country. The full
 * address (name, street, postcode, phone) needs the order's receipt token too. The email is not a secret, so it must
 * not unlock a home address on its own.
 */
export function redactShippingAddress(address: unknown): { city: string | null; province: string | null; country: string | null } | null {
  if (!address || typeof address !== 'object') return null;
  const a = address as Record<string, unknown>;
  const str = (k: string): string | null => (typeof a[k] === 'string' && a[k] ? (a[k] as string) : null);
  return { city: str('city'), province: str('province') ?? str('region') ?? str('state'), country: str('country') };
}
