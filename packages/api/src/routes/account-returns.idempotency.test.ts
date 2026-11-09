import { describe, expect, it } from 'vitest';
import { isValidIdempotencyKey } from './account-returns.js';

describe('return request idempotency key', () => {
  it('accepts 1 to 200 characters', () => {
    expect(isValidIdempotencyKey('a')).toBe(true);
    expect(isValidIdempotencyKey('k'.repeat(200))).toBe(true);
  });
  it('rejects empty and over-long keys', () => {
    expect(isValidIdempotencyKey('')).toBe(false);
    expect(isValidIdempotencyKey('k'.repeat(201))).toBe(false);
  });
});
