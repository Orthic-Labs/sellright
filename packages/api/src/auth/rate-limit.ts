/**
 * In-memory sliding-window login throttle (admin + customer). Blocks brute-force
 * / credential-stuffing without external infra. Per-process — fine for a single
 * instance; move the store to Redis when running multiple API instances.
 *
 * Keyed by ip+identifier. Failures count; a successful login clears the key.
 */
const WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_FAILURES = 8;

interface Entry { fails: number[]; }
const store = new Map<string, Entry>();

function prune(e: Entry, now: number): void {
  e.fails = e.fails.filter((t) => now - t < WINDOW_MS);
}

/** Throw-free check: returns retryAfterSeconds>0 if currently locked out. */
export function loginRetryAfter(ip: string, identifier: string): number {
  const key = `${ip}|${identifier.toLowerCase()}`;
  const e = store.get(key);
  if (!e) return 0;
  const now = Date.now();
  prune(e, now);
  if (e.fails.length < MAX_FAILURES) return 0;
  const oldest = e.fails[0]!;
  return Math.ceil((WINDOW_MS - (now - oldest)) / 1000);
}

export function recordLoginFailure(ip: string, identifier: string): void {
  const key = `${ip}|${identifier.toLowerCase()}`;
  const e = store.get(key) ?? { fails: [] };
  const now = Date.now();
  prune(e, now);
  e.fails.push(now);
  store.set(key, e);
  // opportunistic cleanup so the map can't grow unbounded
  if (store.size > 5000) for (const [k, v] of store) { prune(v, now); if (!v.fails.length) store.delete(k); }
}

export function clearLoginAttempts(ip: string, identifier: string): void {
  store.delete(`${ip}|${identifier.toLowerCase()}`);
}

/** Best-effort client IP from proxy headers (nginx/Cloudflare) or fallback. */
export function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? 'unknown';
}
