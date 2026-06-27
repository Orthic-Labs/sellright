import { describe, expect, it } from 'vitest';
import { normalizeWebhookBatchLimit } from './emit.js';

describe('normalizeWebhookBatchLimit', () => {
  it('defaults to 50 for absent or invalid limits', () => {
    expect(normalizeWebhookBatchLimit()).toBe(50);
    expect(normalizeWebhookBatchLimit(Number.NaN)).toBe(50);
    expect(normalizeWebhookBatchLimit(Number.POSITIVE_INFINITY)).toBe(50);
  });

  it('clamps to a safe inclusive range', () => {
    expect(normalizeWebhookBatchLimit(0)).toBe(1);
    expect(normalizeWebhookBatchLimit(10.8)).toBe(10);
    expect(normalizeWebhookBatchLimit(2000)).toBe(500);
  });
});
