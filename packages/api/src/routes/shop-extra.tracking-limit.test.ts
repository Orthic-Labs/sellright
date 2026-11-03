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

describe('tracking aggregate and email-failure budgets (audit 2026-11-02)', () => {
  it('the per-IP aggregate allows 30 lookups an hour across distinct codes, then throttles, per store and IP', async () => {
    vi.resetModules();
    const { trackingIpKey, trackingIpRetryAfter } = await import('./shop-extra.tracking-limit.js');
    const k = trackingIpKey('s1', '9.9.9.9');
    for (let i = 0; i < 30; i++) expect(await trackingIpRetryAfter(k)).toBe(0);
    expect(await trackingIpRetryAfter(k)).toBeGreaterThan(0);
    expect(await trackingIpRetryAfter(trackingIpKey('s1', '9.9.9.8'))).toBe(0);
    expect(await trackingIpRetryAfter(trackingIpKey('s2', '9.9.9.9'))).toBe(0);
  });
  it('counts only failures per (store, IP, email), case-insensitively, and a success clears them', async () => {
    vi.resetModules();
    const m = await import('./shop-extra.tracking-limit.js');
    const k = m.trackingEmailKey('s1', '1.1.1.1', ' Victim@Example.com ');
    expect(k).toBe(m.trackingEmailKey('s1', '1.1.1.1', 'victim@example.com'));
    expect(k).not.toBe(m.trackingEmailKey('s1', '1.1.1.2', 'victim@example.com'));
    for (let i = 0; i < 5; i++) { expect(await m.trackingEmailFailureRetryAfter(k)).toBe(0); await m.recordTrackingEmailFailure(k); }
    expect(await m.trackingEmailFailureRetryAfter(k)).toBeGreaterThan(0);
    await m.clearTrackingEmailFailures(k);
    expect(await m.trackingEmailFailureRetryAfter(k)).toBe(0);
  });
});

describe('redactShippingAddress', () => {
  it('keeps only city, region and country', async () => {
    const { redactShippingAddress } = await import('./shop-extra.tracking-limit.js');
    expect(redactShippingAddress({ fullName: 'A B', line1: '1 Main St', line2: 'Apt 2', city: 'Austin', province: 'TX', postalCode: '78701', country: 'US', phone: '555' }))
      .toEqual({ city: 'Austin', province: 'TX', country: 'US' });
    expect(redactShippingAddress(null)).toBeNull();
    expect(redactShippingAddress('x')).toBeNull();
  });
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
