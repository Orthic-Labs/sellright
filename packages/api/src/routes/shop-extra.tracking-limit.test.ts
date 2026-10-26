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

describe('tracking key (previous-platform parity: IP + order code, never the email)', () => {
  it('is independent of the email and of how the order code is spelled', async () => {
    const { trackingKey } = await import('./shop-extra.tracking-limit.js');
    expect(trackingKey('s1', '1.2.3.4', '#1001')).toBe(trackingKey('s1', '1.2.3.4', ' 1001 '));
    expect(trackingKey('s1', '1.2.3.4', 'ab-1')).toBe(trackingKey('s1', '1.2.3.4', 'AB-1'));
  });
  it('separates stores, clients and orders', async () => {
    const { trackingKey } = await import('./shop-extra.tracking-limit.js');
    const base = trackingKey('s1', '1.2.3.4', '1001');
    expect(trackingKey('s2', '1.2.3.4', '1001')).not.toBe(base);
    expect(trackingKey('s1', '5.6.7.8', '1001')).not.toBe(base);
    expect(trackingKey('s1', '1.2.3.4', '1002')).not.toBe(base);
  });
});
