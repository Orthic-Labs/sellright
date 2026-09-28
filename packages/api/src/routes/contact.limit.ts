/**
 * Sliding-window throttles for the public, unauthenticated contact +
 * restock-request endpoints (PAR-01 / PAR-05). Storage is pluggable
 * (SELLRIGHT-ISSUES P1 — see auth/rate-limit-backend.ts): RATE_LIMIT_BACKEND
 * =postgres (default) shares state across every API process; =memory is an
 * explicit single-process opt-out. Same shape as shop-extra.newsletter-limit.ts
 * — a dedicated per-purpose bucket so tuning one surface never changes
 * another's allowance.
 *
 * Limits mirror the legacy plugins being ported: contact-form used
 * 5 submissions/hour/IP and the waitlist resolver used 10/hour/IP.
 */
import { rateLimitBackend } from '../auth/rate-limit-backend.js';

const HOUR = 60 * 60 * 1000;

function makeIpLimiter(bucket: string, windowMs: number, maxAttempts: number) {
  return {
    /** Throw-free check: retryAfterSeconds>0 while the IP is over budget. */
    retryAfter: (ip: string): Promise<number> => rateLimitBackend().check(bucket, ip, windowMs, maxAttempts),
    record: (ip: string): Promise<void> => rateLimitBackend().recordFailure(bucket, ip, windowMs),
  };
}

const contact = makeIpLimiter('contact', HOUR, 5); // contact-form parity: 5/hr/IP
const restock = makeIpLimiter('restock', HOUR, 10); // waitlist parity: 10/hr/IP

export const contactRetryAfter = contact.retryAfter;
export const recordContactAttempt = contact.record;
export const restockRetryAfter = restock.retryAfter;
export const recordRestockAttempt = restock.record;
