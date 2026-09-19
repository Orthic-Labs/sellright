// Per-process protection, matching the source store's ten-attempt hourly window.
// Use shared storage before scaling the API across multiple instances.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_KEYS = 5000;
const attempts = new Map<string, number[]>();

export function trackingRetryAfter(key: string): number {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= 10) return Math.max(1, Math.ceil((recent[0]! + WINDOW_MS - now) / 1000));
  if (!attempts.has(key) && attempts.size >= MAX_KEYS) {
    for (const [k, timestamps] of attempts) {
      if (timestamps.at(-1)! + WINDOW_MS <= now) attempts.delete(k);
    }
    // Fail closed at capacity instead of evicting an attacker's active bucket.
    if (attempts.size >= MAX_KEYS) return 60;
  }
  attempts.set(key, [...recent, now]);
  return 0;
}

export function clearTrackingAttempts(key: string): void {
  attempts.delete(key);
}
