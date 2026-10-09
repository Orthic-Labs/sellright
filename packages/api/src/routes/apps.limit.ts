/**
 * SEC: sliding-window throttles for the public, unauthenticated app-licensing
 * surface (trial issuance + activate/refresh/deactivate) and the anonymous
 * cart endpoint. Storage is pluggable (SELLRIGHT-ISSUES P1 — see
 * auth/rate-limit-backend.ts): RATE_LIMIT_BACKEND=postgres (default) shares
 * state across every API process; =memory is an explicit single-process
 * opt-out. Same shape as contact.limit.ts / auth/rate-limit.ts — a dedicated
 * per-purpose bucket, keyed by IP + a caller-supplied identifier (email,
 * license key, or nothing for a pure per-IP bucket), so tuning one surface
 * never changes another's allowance.
 *
 * Rationale for the specific limits:
 *   - trial: mints a real license + sends an email per call — abuse mints
 *     unlimited trial licenses / mailbombs an inbox. 5/hour per (ip, email).
 *   - license actions (activate/refresh/deactivate): guessing/credential-
 *     stuffing a licenseKey, or hammering the entitlement authority.
 *     20/15min per (ip, licenseKey).
 *   - cart: legitimate shoppers can hit this often (every add/remove), and a
 *     single IP can legitimately open several carts in a short window
 *     (multiple tabs/devices behind one NAT, or a busy storefront/e2e test
 *     session). The limit only needs to stop a scripted flood, not normal
 *     use. 60/min/IP.
 */
import { rateLimitBackend } from '../auth/rate-limit-backend.js';

function keyFor(ip: string, identifier: string): string {
  return `${ip}|${identifier.toLowerCase()}`;
}

function makeKeyedLimiter(bucket: string, windowMs: number, maxAttempts: number) {
  return {
    /** Throw-free check: retryAfterSeconds>0 while the (ip, identifier) pair is over budget. */
    retryAfter: (ip: string, identifier = ''): Promise<number> =>
      rateLimitBackend().check(bucket, keyFor(ip, identifier), windowMs, maxAttempts),
    record: (ip: string, identifier = ''): Promise<void> =>
      rateLimitBackend().recordFailure(bucket, keyFor(ip, identifier), windowMs),
  };
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const trial = makeKeyedLimiter('apps-trial', HOUR, 5); // 5/hr per (ip, email)
const licenseAction = makeKeyedLimiter('apps-license-action', 15 * MIN, 20); // 20/15min per (ip, licenseKey)
const cart = makeKeyedLimiter('apps-cart', MIN, 60); // 60/min per ip
const storekitVerifyFailure = makeKeyedLimiter('storekit-verify-failure', HOUR, 30); // 30/hr per (ip, app)

export const trialRetryAfter = trial.retryAfter;
export const recordTrialAttempt = trial.record;
export const licenseActionRetryAfter = licenseAction.retryAfter;
export const recordLicenseAction = licenseAction.record;
export const cartRetryAfter = cart.retryAfter;
export const recordCartAttempt = cart.record;
export const storekitVerifyFailureRetryAfter = storekitVerifyFailure.retryAfter;
export const recordStorekitVerifyFailure = storekitVerifyFailure.record;
