import { describe, it, expect } from 'vitest';
import { selectAutomaticPromotion, type AutoPromoRow } from './auto-discount.js';

const ctx = (subtotal: number, verifications: string[] = []) => ({ subtotal, activeVerifications: verifications });

describe('automatic discount selection', () => {
  it('returns null when there are no automatic promotions', () => {
    expect(selectAutomaticPromotion([], ctx(10000))).toBeNull();
  });

  it('picks the higher-priority promotion even if it discounts less', () => {
    const rows: AutoPromoRow[] = [
      { id: 'a', type: 'percentage', value: 20, conditions: null, priority: 0 },
      { id: 'b', type: 'percentage', value: 5, conditions: null, priority: 10 },
    ];
    expect(selectAutomaticPromotion(rows, ctx(10000))?.id).toBe('b');
  });

  it('breaks ties on the larger discount', () => {
    const rows: AutoPromoRow[] = [
      { id: 'a', type: 'percentage', value: 10, conditions: null, priority: 5 }, // 1000c
      { id: 'b', type: 'fixed', value: 1500, conditions: null, priority: 5 }, //    1500c
    ];
    expect(selectAutomaticPromotion(rows, ctx(10000))?.id).toBe('b');
  });

  it('skips promotions whose conditions are not met', () => {
    const rows: AutoPromoRow[] = [
      { id: 'a', type: 'percentage', value: 25, conditions: [{ code: 'minimum_order_amount', args: [{ name: 'amount', value: '20000' }] }], priority: 5 },
      { id: 'b', type: 'percentage', value: 5, conditions: null, priority: 0 },
    ];
    // subtotal 10000 < 20000 → 'a' ineligible, falls back to 'b'
    expect(selectAutomaticPromotion(rows, ctx(10000))?.id).toBe('b');
    // subtotal 25000 ≥ 20000 → 'a' eligible and higher priority
    expect(selectAutomaticPromotion(rows, ctx(25000))?.id).toBe('a');
  });

  it('respects verified-customer conditions', () => {
    const rows: AutoPromoRow[] = [
      { id: 'vip', type: 'percentage', value: 15, conditions: [{ code: 'verified_customer', args: [{ name: 'categories', value: '["student"]' }] }], priority: 5 },
    ];
    expect(selectAutomaticPromotion(rows, ctx(10000, []))).toBeNull();
    expect(selectAutomaticPromotion(rows, ctx(10000, ['student']))?.id).toBe('vip');
  });
});
