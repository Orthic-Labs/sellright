/**
 * SEC: in-memory sliding-window throttles for the public, unauthenticated
 * app-licensing surface (trial issuance + activate/refresh/deactivate) and
 * the anonymous cart endpoint. Same shape as contact.limit.ts /
 * auth/rate-limit.ts — a dedicated per-purpose bucket, keyed by IP + a
 * caller-supplied identifier (email, license key, or nothing for a pure
 * per-IP bucket), so tuning one surface never changes another's allowance.
 * Per-process: fine for a single API instance; move to Redis before
 * multi-instance.
 *
 * Rationale for the specific limits:
 *   - trial: mints a real license + sends an email per call — abuse mints
 *     unlimited trial licenses / mailbombs an inbox. 5/hour per (ip, email).
 *   - license actions (activate/refresh/deactivate): guessing/credential-
 *     stuffing a licenseKey, or hammering the entitlement authority.
 *     20/15min per (ip, licenseKey).
 *   - cart: legitimate shoppers can hit this often (every add/remove); the
 *     limit only needs to stop a scripted flood, not normal use. 30/min/IP.
 */
interface Entry { attempts: number[]; }

function makeKeyedLimiter(windowMs: number, maxAttempts: number) {
  const store = new Map<string, Entry>();
  const keyFor = (ip: string, identifier: string) => `${ip}|${identifier.toLowerCase()}`;
  const prune = (e: Entry, now: number) => {
    e.attempts = e.attempts.filter((t) => now - t < windowMs);
  };
  return {
    /** Throw-free check: retryAfterSeconds>0 while the (ip, identifier) pair is over budget. */
    retryAfter(ip: string, identifier = ''): number {
      const e = store.get(keyFor(ip, identifier));
      if (!e) return 0;
      const now = Date.now();
      prune(e, now);
      if (e.attempts.length < maxAttempts) return 0;
      const oldest = e.attempts[0]!;
      return Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    },
    record(ip: string, identifier = ''): void {
      const key = keyFor(ip, identifier);
      const e = store.get(key) ?? { attempts: [] };
      const now = Date.now();
      prune(e, now);
      e.attempts.push(now);
      store.set(key, e);
      // Opportunistic cleanup so the map can't grow unbounded.
      if (store.size > 5000) for (const [k, v] of store) { prune(v, now); if (!v.attempts.length) store.delete(k); }
    },
  };
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const trial = makeKeyedLimiter(HOUR, 5); // 5/hr per (ip, email)
const licenseAction = makeKeyedLimiter(15 * MIN, 20); // 20/15min per (ip, licenseKey)
const cart = makeKeyedLimiter(MIN, 30); // 30/min per ip

export const trialRetryAfter = trial.retryAfter;
export const recordTrialAttempt = trial.record;
export const licenseActionRetryAfter = licenseAction.retryAfter;
export const recordLicenseAction = licenseAction.record;
export const cartRetryAfter = cart.retryAfter;
export const recordCartAttempt = cart.record;
