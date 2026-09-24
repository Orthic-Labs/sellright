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
  // Mirrors the real deployment defaults (env.ts): CART_TTL_DAYS and
  // CART_RETENTION_DAYS both default to 1 (24h) — owner decision 2026-09-24
  // that idle carts, including abandoned/non-converted ones, are purged
  // within a day. CART_ABANDON_HOURS default (4h) is unrelated to deletion —
  // it only flags a non-empty cart 'abandoned' for recovery/analytics.
  const defaults = { abandonAfterHours: 4, ttlDays: 1, retentionDays: 1 };

  it('falls back to deployment defaults when the store has no cart config', () => {
    expect(cartLifecycleFromConfig(null, defaults)).toEqual({ abandonAfterHours: 4, ttlDays: 1, retentionDays: 1 });
    expect(cartLifecycleFromConfig({}, defaults)).toEqual({ abandonAfterHours: 4, ttlDays: 1, retentionDays: 1 });
    expect(cartLifecycleFromConfig({ cart: {} }, defaults)).toEqual({ abandonAfterHours: 4, ttlDays: 1, retentionDays: 1 });
  });
  it('reads per-store overrides from config.cart', () => {
    expect(cartLifecycleFromConfig({ cart: { abandonAfterHours: 8, ttlDays: 10, retentionDays: 90 } }, defaults))
      .toEqual({ abandonAfterHours: 8, ttlDays: 10, retentionDays: 90 });
  });
  it('retentionDays falls back to the deployment default (CART_RETENTION_DAYS) when the store sets nothing', () => {
    expect(cartLifecycleFromConfig({ cart: { abandonAfterHours: 8 } }, defaults).retentionDays).toBe(1);
  });
  it('a caller can still pass retentionDays: null as its deployment default to retain abandoned carts indefinitely', () => {
    expect(cartLifecycleFromConfig({ cart: {} }, { ...defaults, retentionDays: null }).retentionDays).toBeNull();
    expect(cartLifecycleFromConfig({ cart: { abandonAfterHours: 8 } }, { ...defaults, retentionDays: null }).retentionDays).toBeNull();
  });
  it('rejects non-positive / non-numeric per-store values, falling back to the deployment default instead of purging everything', () => {
    // retentionDays: 0 would mean "delete abandoned carts immediately" — never
    // honor it; only a positive integer per-store override is valid.
    const cfg = cartLifecycleFromConfig({ cart: { abandonAfterHours: 0, ttlDays: -3, retentionDays: 0 } }, defaults);
    expect(cfg.abandonAfterHours).toBe(4);
    expect(cfg.ttlDays).toBe(1);
    expect(cfg.retentionDays).toBe(1);
    expect(cartLifecycleFromConfig({ cart: { retentionDays: '30' } }, defaults).retentionDays).toBe(1);
  });
});
