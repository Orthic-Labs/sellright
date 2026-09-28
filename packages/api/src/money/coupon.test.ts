import { describe, expect, it } from 'vitest';
import { evaluateCoupon } from './coupon.js';

describe('evaluateCoupon — R24 freeShipping passthrough', () => {
  it('carries freeShipping through onto the returned promotion when true', () => {
    const ev = evaluateCoupon(
      { type: 'percentage', value: 15, conditions: null, freeShipping: true },
      { subtotal: 10000, activeVerifications: [] },
    );
    expect(ev.valid).toBe(true);
    expect(ev.promotion).toMatchObject({ type: 'percentage', value: 15, freeShipping: true });
  });

  it('carries freeShipping: false/undefined through unchanged', () => {
    const ev = evaluateCoupon(
      { type: 'fixed', value: 500, conditions: null },
      { subtotal: 10000, activeVerifications: [] },
    );
    expect(ev.valid).toBe(true);
    expect(ev.promotion?.freeShipping).toBeUndefined();
  });

  it('a bare free_shipping promotion is unaffected by the new field', () => {
    const ev = evaluateCoupon(
      { type: 'free_shipping', value: 0, conditions: null },
      { subtotal: 10000, activeVerifications: [] },
    );
    expect(ev.valid).toBe(true);
    expect(ev.promotion).toMatchObject({ type: 'free_shipping', value: 0 });
  });
});
