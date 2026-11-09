import { describe, expect, it } from 'vitest';
import { SignupMeta, SignupTopic } from './shop-extra.js';

describe('signup topic', () => {
  it('accepts the general newsletter, app keys and restock topics', () => {
    for (const t of ['', 'viewright', 'scraperight', `restock:${'a'.repeat(36)}`, 'app_key-1.2']) {
      expect(SignupTopic.safeParse(t).success, t).toBe(true);
    }
  });
  it('rejects markup, whitespace, leading punctuation and over-long values', () => {
    for (const t of ['<b>x</b>', 'two words', ':restock', 'a'.repeat(65), 'line\nbreak', 'https://example.com']) {
      expect(SignupTopic.safeParse(t).success, t).toBe(false);
    }
  });
});

describe('signup meta', () => {
  it('accepts a small map of primitive values', () => {
    expect(SignupMeta.safeParse({ plan: 'pro', seats: 3, beta: true }).success).toBe(true);
  });
  it('rejects nested values, long strings and too many keys', () => {
    expect(SignupMeta.safeParse({ a: { b: 1 } }).success).toBe(false);
    expect(SignupMeta.safeParse({ a: 'x'.repeat(501) }).success).toBe(false);
    expect(SignupMeta.safeParse(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1]))).success).toBe(false);
    expect(SignupMeta.safeParse(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 1]))).success).toBe(true);
  });
});
