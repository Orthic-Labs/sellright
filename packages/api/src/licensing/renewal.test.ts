import { describe, expect, it } from 'vitest';
import { extendEntitlement } from './renewal.js';

const NOW = new Date('2026-06-20T00:00:00Z');

describe('extendEntitlement', () => {
  it('perpetual (null duration) stays perpetual', () => {
    expect(extendEntitlement(new Date(), null, NOW)).toBeNull();
  });
  it('renews from the current period end when still active (stacks)', () => {
    const cur = new Date('2026-07-01T00:00:00Z');
    expect(extendEntitlement(cur, 30, NOW)).toEqual(new Date('2026-07-31T00:00:00Z'));
  });
  it('renews from now when lapsed (current in the past)', () => {
    const cur = new Date('2026-06-01T00:00:00Z');
    expect(extendEntitlement(cur, 30, NOW)).toEqual(new Date('2026-07-20T00:00:00Z'));
  });
  it('first issue (null current) starts from now', () => {
    expect(extendEntitlement(null, 30, NOW)).toEqual(new Date('2026-07-20T00:00:00Z'));
  });
});
