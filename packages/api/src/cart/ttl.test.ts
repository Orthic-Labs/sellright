import { describe, expect, it } from 'vitest';
import { cartExpiry, isAbandonable, cartLifecycleFromConfig } from './ttl.js';

describe('cartExpiry', () => {
  it('adds TTL days to now', () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    expect(cartExpiry(now, 30).toISOString()).toBe('2026-07-20T00:00:00.000Z');
  });
});

describe('isAbandonable', () => {
  const now = new Date('2026-06-20T12:00:00.000Z');
  it('true when it has lines and is older than the window', () => {
    expect(isAbandonable(new Date('2026-06-20T07:00:00.000Z'), 2, now, 4)).toBe(true); // 5h > 4h
  });
  it('false when empty', () => {
    expect(isAbandonable(new Date('2026-06-20T00:00:00.000Z'), 0, now, 4)).toBe(false);
  });
  it('false when still within the window', () => {
    expect(isAbandonable(new Date('2026-06-20T10:00:00.000Z'), 3, now, 4)).toBe(false); // 2h < 4h
  });
});

describe('cartLifecycleFromConfig (CART-04)', () => {
  const defaults = { abandonAfterHours: 4, ttlDays: 30 };
  it('falls back to deployment defaults when the store has no cart config', () => {
    expect(cartLifecycleFromConfig(null, defaults)).toEqual({ abandonAfterHours: 4, ttlDays: 30, retentionDays: null });
    expect(cartLifecycleFromConfig({}, defaults)).toEqual({ abandonAfterHours: 4, ttlDays: 30, retentionDays: null });
    expect(cartLifecycleFromConfig({ cart: {} }, defaults)).toEqual({ abandonAfterHours: 4, ttlDays: 30, retentionDays: null });
  });
  it('reads per-store overrides from config.cart', () => {
    expect(cartLifecycleFromConfig({ cart: { abandonAfterHours: 8, ttlDays: 10, retentionDays: 90 } }, defaults))
      .toEqual({ abandonAfterHours: 8, ttlDays: 10, retentionDays: 90 });
  });
  it('retentionDays defaults to null (retain abandoned carts indefinitely)', () => {
    expect(cartLifecycleFromConfig({ cart: { abandonAfterHours: 8 } }, defaults).retentionDays).toBeNull();
  });
  it('rejects non-positive / non-numeric values instead of purging everything', () => {
    // retentionDays: 0 would mean "delete abandoned carts immediately" — never
    // honor it; only a positive integer is a valid retention window.
    const cfg = cartLifecycleFromConfig({ cart: { abandonAfterHours: 0, ttlDays: -3, retentionDays: 0 } }, defaults);
    expect(cfg.abandonAfterHours).toBe(4);
    expect(cfg.ttlDays).toBe(30);
    expect(cfg.retentionDays).toBeNull();
    expect(cartLifecycleFromConfig({ cart: { retentionDays: '30' } }, defaults).retentionDays).toBeNull();
  });
});
