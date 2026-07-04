/**
 * In-memory sliding-window throttle for the public, unauthenticated newsletter
 * signup endpoint (POST /v1/shop/newsletter-signup). Separate from
 * `auth/rate-limit.ts`'s login throttle because that module's threshold
 * (MAX_FAILURES = 8) is a shared constant used by login/register/pay/
 * check-email — changing it would change behavior for those routes too.
 * This is a small, dedicated 5-attempts/15-min bucket keyed by IP, counting
 * every attempt (not just failures) since every unauthenticated POST here is
 * an outbound-fetch amplification opportunity, not just a "bad credential".
 */
const WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_ATTEMPTS = 5;

interface Entry { attempts: number[]; }
const store = new Map<string, Entry>();

function prune(e: Entry, now: number): void {
  e.attempts = e.attempts.filter((t) => now - t < WINDOW_MS);
}

/** Throw-free check: returns retryAfterSeconds>0 if currently rate-limited. */
export function newsletterRetryAfter(ip: string): number {
  const e = store.get(ip);
  if (!e) return 0;
  const now = Date.now();
  prune(e, now);
  if (e.attempts.length < MAX_ATTEMPTS) return 0;
  const oldest = e.attempts[0]!;
  return Math.ceil((WINDOW_MS - (now - oldest)) / 1000);
}

export function recordNewsletterAttempt(ip: string): void {
  const e = store.get(ip) ?? { attempts: [] };
  const now = Date.now();
  prune(e, now);
  e.attempts.push(now);
  store.set(ip, e);
  // opportunistic cleanup so the map can't grow unbounded
  if (store.size > 5000) for (const [k, v] of store) { prune(v, now); if (!v.attempts.length) store.delete(k); }
}
