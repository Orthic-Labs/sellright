import { describe, expect, it } from 'vitest';
import { dayRangeConditions, dayRangeError, isValidDay } from './day-range.js';
import { sql } from 'drizzle-orm';

describe('day-range', () => {
  it('accepts real calendar days only', () => {
    expect(isValidDay('2026-10-09')).toBe(true);
    expect(isValidDay('2024-02-29')).toBe(true);
    expect(isValidDay('2026-02-31')).toBe(false);
    expect(isValidDay('2026-13-01')).toBe(false);
    expect(isValidDay('10/09/2026')).toBe(false);
  });

  it('validates ordering and open ends', () => {
    expect(dayRangeError({})).toBeNull();
    expect(dayRangeError({ from: '2026-10-01' })).toBeNull();
    expect(dayRangeError({ to: '2026-10-01' })).toBeNull();
    expect(dayRangeError({ from: '2026-10-02', to: '2026-10-01' })).toMatch(/after/);
    expect(dayRangeError({ from: 'nope' })).toMatch(/from/);
    expect(dayRangeError({ to: '2026-99-99' })).toMatch(/to/);
  });

  it('emits one condition per bound', () => {
    const col = sql`o.created_at`;
    expect(dayRangeConditions(col, {})).toHaveLength(0);
    expect(dayRangeConditions(col, { from: '2026-10-01' })).toHaveLength(1);
    expect(dayRangeConditions(col, { from: '2026-10-01', to: '2026-10-09' })).toHaveLength(2);
  });
});
