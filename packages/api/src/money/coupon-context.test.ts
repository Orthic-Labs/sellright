import { describe, expect, it } from 'vitest';
import { couponItemsFromFacts, type CouponMatchFacts } from './coupon-context.js';

describe('couponItemsFromFacts', () => {
  it('joins lines to their product facts by productId', () => {
    const facts = new Map<string, CouponMatchFacts>([
      ['p1', { productId: 'p1', tags: ['edc'], collectionIds: ['c1'] }],
    ]);
    const out = couponItemsFromFacts([{ quantity: 2, productId: 'p1' }], facts);
    expect(out).toEqual([{ quantity: 2, productId: 'p1', tags: ['edc'], collectionIds: ['c1'] }]);
  });

  it('drops lines with a null productId (deleted variant) instead of throwing', () => {
    const out = couponItemsFromFacts([{ quantity: 1, productId: null }], new Map());
    expect(out).toEqual([]);
  });

  it('defaults to empty tags/collectionIds when a product has no facts row (e.g. deleted product)', () => {
    const out = couponItemsFromFacts([{ quantity: 1, productId: 'ghost' }], new Map());
    expect(out).toEqual([{ quantity: 1, productId: 'ghost', tags: [], collectionIds: [] }]);
  });
});
