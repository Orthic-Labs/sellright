import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

describe('tracking throttle', () => {
  it('reserves attempts synchronously, expires them, and clears successful lookups', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const { trackingRetryAfter, clearTrackingAttempts } = await import('./shop-extra.tracking-limit.js');
    for (let i = 0; i < 10; i++) expect(trackingRetryAfter('buyer')).toBe(0);
    expect(trackingRetryAfter('buyer')).toBe(3600);
    expect(trackingRetryAfter('other')).toBe(0);
    vi.advanceTimersByTime(3600000);
    expect(trackingRetryAfter('buyer')).toBe(0);
    clearTrackingAttempts('buyer');
    for (let i = 0; i < 10; i++) expect(trackingRetryAfter('buyer')).toBe(0);
  });

  it('fails closed at capacity without evicting live buckets', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const { trackingRetryAfter } = await import('./shop-extra.tracking-limit.js');
    for (let i = 0; i < 5000; i++) expect(trackingRetryAfter(`key-${i}`)).toBe(0);
    expect(trackingRetryAfter('overflow')).toBe(60);
    vi.advanceTimersByTime(3600000);
    expect(trackingRetryAfter('overflow')).toBe(0);
  });
});
