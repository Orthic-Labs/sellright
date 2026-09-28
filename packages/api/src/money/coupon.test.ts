import { describe, expect, it } from 'vitest';
import { evaluateCoupon } from './coupon.js';

const item = (over: Partial<{ quantity: number; productId: string; tags: string[]; collectionIds: string[] }>) =>
  ({ quantity: 1, productId: 'p1', tags: [], collectionIds: [], ...over });

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

describe('evaluateCoupon — native item-targeting conditions (no legacy facets)', () => {
  const cond = (code: string, args: Record<string, string>) => ({ code, args: Object.entries(args).map(([name, value]) => ({ name, value })) });
  const base = { subtotal: 10000, activeVerifications: [] as string[] };

  it('at_least_n_in_collections matches on collection membership + quantity', () => {
    const promo = { type: 'percentage' as const, value: 10, conditions: [cond('at_least_n_in_collections', { minimum: '2', collectionIds: '["c1"]' })] };
    expect(evaluateCoupon(promo, base).valid).toBe(false); // no items at all
    expect(evaluateCoupon(promo, { ...base, items: [item({ quantity: 1, collectionIds: ['c1'] })] }).valid).toBe(false); // below minimum
    expect(evaluateCoupon(promo, { ...base, items: [item({ quantity: 2, collectionIds: ['other'] })] }).valid).toBe(false); // wrong collection
    expect(evaluateCoupon(promo, { ...base, items: [item({ quantity: 2, collectionIds: ['c1'] })] }).valid).toBe(true);
  });

  it('at_least_n_products matches on explicit product id + quantity', () => {
    const promo = { type: 'fixed' as const, value: 500, conditions: [cond('at_least_n_products', { minimum: '3', productIds: '["p1","p2"]' })] };
    expect(evaluateCoupon(promo, { ...base, items: [item({ quantity: 2, productId: 'p1' })] }).valid).toBe(false);
    expect(evaluateCoupon(promo, { ...base, items: [item({ quantity: 2, productId: 'p1' }), item({ quantity: 1, productId: 'p2' })] }).valid).toBe(true);
    expect(evaluateCoupon(promo, { ...base, items: [item({ quantity: 3, productId: 'unrelated' })] }).valid).toBe(false);
  });

  it('at_least_n_with_tags matches on native product.tags + quantity', () => {
    const promo = { type: 'percentage' as const, value: 15, conditions: [cond('at_least_n_with_tags', { minimum: '1', tags: '["edc"]' })] };
    expect(evaluateCoupon(promo, { ...base, items: [item({ quantity: 1, tags: ['pocket'] })] }).valid).toBe(false);
    expect(evaluateCoupon(promo, { ...base, items: [item({ quantity: 1, tags: ['edc', 'pocket'] })] }).valid).toBe(true);
  });

  it('an unresolved/empty collectionIds list (importer found no eligible product) always fails closed', () => {
    const promo = { type: 'percentage' as const, value: 10, conditions: [cond('at_least_n_in_collections', { minimum: '1', collectionIds: '[]' })] };
    expect(evaluateCoupon(promo, { ...base, items: [item({ quantity: 5, collectionIds: ['anything'] })] }).valid).toBe(false);
  });

  it('an unrecognized condition code is rejected — no silent facet fallback', () => {
    const promo = { type: 'percentage' as const, value: 10, conditions: [cond('at_least_n_with_facets', { minimum: '1', facets: '["1"]' })] };
    const ev = evaluateCoupon(promo, { ...base, items: [item({ quantity: 5 })] });
    expect(ev.valid).toBe(false);
    expect(ev.reason).toMatch(/unsupported condition/);
  });
});
