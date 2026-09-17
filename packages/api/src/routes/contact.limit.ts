/**
 * In-memory sliding-window throttles for the public, unauthenticated contact
 * + restock-request endpoints (PAR-01 / PAR-05). Same shape as
 * shop-extra.newsletter-limit.ts — a dedicated per-purpose bucket so tuning
 * one surface never changes another's allowance. Per-process: fine for a
 * single API instance; move to Redis before multi-instance.
 *
 * Limits mirror the legacy plugins being ported: contact-form used
 * 5 submissions/hour/IP and the waitlist resolver used 10/hour/IP.
 */
interface Entry { attempts: number[]; }

function makeIpLimiter(windowMs: number, maxAttempts: number) {
  const store = new Map<string, Entry>();
  const prune = (e: Entry, now: number) => {
    e.attempts = e.attempts.filter((t) => now - t < windowMs);
  };
  return {
    /** Throw-free check: retryAfterSeconds>0 while the IP is over budget. */
    retryAfter(ip: string): number {
      const e = store.get(ip);
      if (!e) return 0;
      const now = Date.now();
      prune(e, now);
      if (e.attempts.length < maxAttempts) return 0;
      const oldest = e.attempts[0]!;
      return Math.ceil((windowMs - (now - oldest)) / 1000);
    },
    record(ip: string): void {
      const e = store.get(ip) ?? { attempts: [] };
      const now = Date.now();
      prune(e, now);
      e.attempts.push(now);
      store.set(ip, e);
      // Opportunistic cleanup so the map can't grow unbounded.
      if (store.size > 5000) for (const [k, v] of store) { prune(v, now); if (!v.attempts.length) store.delete(k); }
    },
  };
}

const HOUR = 60 * 60 * 1000;
const contact = makeIpLimiter(HOUR, 5); // contact-form parity: 5/hr/IP
const restock = makeIpLimiter(HOUR, 10); // waitlist parity: 10/hr/IP

export const contactRetryAfter = contact.retryAfter;
export const recordContactAttempt = contact.record;
export const restockRetryAfter = restock.retryAfter;
export const recordRestockAttempt = restock.record;
