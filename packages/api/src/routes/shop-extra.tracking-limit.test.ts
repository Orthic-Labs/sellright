import { afterEach, describe, expect, it, vi } from 'vitest';

// NODE_ENV=test (see vitest setup) selects the in-memory rate-limit backend
// by default — no database needed for these unit tests.
afterEach(() => vi.useRealTimers());

describe('tracking throttle', () => {
  it('reserves attempts synchronously, expires them, and clears successful lookups', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const { trackingRetryAfter, clearTrackingAttempts } = await import('./shop-extra.tracking-limit.js');
    for (let i = 0; i < 10; i++) expect(await trackingRetryAfter('buyer')).toBe(0);
    expect(await trackingRetryAfter('buyer')).toBe(3600);
    expect(await trackingRetryAfter('other')).toBe(0);
    vi.advanceTimersByTime(3600000);
    expect(await trackingRetryAfter('buyer')).toBe(0);
    await clearTrackingAttempts('buyer');
    for (let i = 0; i < 10; i++) expect(await trackingRetryAfter('buyer')).toBe(0);
  });

  // The MAX_KEYS "fail closed at capacity" behavior this test used to cover
  // was an anti-unbounded-Map safeguard specific to the OLD private in-memory
  // implementation. Now that every *.limit.ts bucket shares one pluggable
  // backend (rate-limit-backend.ts), that concern lives once, generically, in
  // createMemoryRateLimitBackend()'s own opportunistic cleanup (evicts empty
  // entries once the map exceeds 5000 total keys ACROSS ALL buckets, never a
  // hard per-bucket cap) — and doesn't apply at all to the default Postgres
  // backend (an indexed table, not an unbounded process-memory Map).
});
