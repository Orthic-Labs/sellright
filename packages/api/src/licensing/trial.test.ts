import { describe, it, expect } from 'vitest';
import { trialExpiresAt, TRIAL_DAYS } from './trial.js';

describe('trialExpiresAt', () => {
  it('is exactly 14 days after the start by default', () => {
    const start = new Date('2026-06-01T00:00:00Z');
    expect(trialExpiresAt(start).toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(TRIAL_DAYS).toBe(14);
  });

  it('accepts a per-store/per-app trial length override', () => {
    const start = new Date('2026-06-01T00:00:00Z');
    expect(trialExpiresAt(start, 30).toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(trialExpiresAt(start, 7).toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });
});
