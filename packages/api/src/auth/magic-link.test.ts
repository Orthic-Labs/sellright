/**
 * Unit tests for the one-time sign-in code helpers (#350) — no DB. Redemption, hashing at rest, single use and the
 * throttle are covered against Postgres in magic-link.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { generateMagicCode, normalizeMagicCode } from './magic-link.js';

describe('generateMagicCode', () => {
  it('is always six digits, zero-padded, and not constant', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generateMagicCode();
      expect(c).toMatch(/^\d{6}$/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(100);
  });
});

describe('normalizeMagicCode', () => {
  it('accepts six digits, ignoring spaces and hyphens', () => {
    expect(normalizeMagicCode('042917')).toBe('042917');
    expect(normalizeMagicCode(' 042 917 ')).toBe('042917');
    expect(normalizeMagicCode('042-917')).toBe('042917');
  });
  it('refuses anything else', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12345a', '12 34 5x', '١٢٣٤٥٦', '0429.17']) expect(normalizeMagicCode(bad)).toBeNull();
  });
});
