import { describe, expect, it } from 'vitest';
import { cartExpiry, isAbandonable } from './ttl.js';

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
