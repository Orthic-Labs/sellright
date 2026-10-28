import { describe, expect, it } from 'vitest';
import { shippingRefundable } from './refunds.js';

describe('shippingRefundable (#406)', () => {
  it('is the full shipping when nothing was refunded', () => {
    expect(shippingRefundable(800, [])).toBe(800);
  });
  it('subtracts the shipping part of pending and settled refunds', () => {
    expect(shippingRefundable(800, [{ state: 'Settled', shippingAmount: 300 }, { state: 'Pending', shippingAmount: 200 }])).toBe(300);
  });
  it('ignores failed refunds and refunds with no shipping part', () => {
    expect(shippingRefundable(800, [{ state: 'Failed', shippingAmount: 800 }, { state: 'Settled', shippingAmount: null }])).toBe(800);
  });
  it('never goes below zero', () => {
    expect(shippingRefundable(500, [{ state: 'Settled', shippingAmount: 600 }])).toBe(0);
  });
});
