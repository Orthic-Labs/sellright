import { describe, expect, it } from 'vitest';
import { calculateOrderTotals } from './totals.js';

describe('calculateOrderTotals', () => {
  it('sums lines, no promo, no tax', () => {
    const t = calculateOrderTotals({
      lines: [{ unitPrice: 4000, quantity: 2 }, { unitPrice: 1500, quantity: 1 }],
      shipping: 800, taxRate: 0,
    });
    expect(t.subtotal).toBe(9500);
    expect(t.discountTotal).toBe(0);
    expect(t.grandTotal).toBe(9500 + 800);
  });

  it('percentage discount rounds at the LINE level', () => {
    // 7201c * 10% = 720.1 -> 720 (half-up) per line
    const t = calculateOrderTotals({
      lines: [{ unitPrice: 7201, quantity: 1 }],
      shipping: 0, taxRate: 0,
      promotion: { type: 'percentage', value: 10 },
    });
    expect(t.discountTotal).toBe(720);
    expect(t.grandTotal).toBe(7201 - 720);
  });

  it('fixed discount is capped at subtotal (never below zero)', () => {
    const t = calculateOrderTotals({
      lines: [{ unitPrice: 5000, quantity: 1 }],
      shipping: 0, taxRate: 0,
      promotion: { type: 'fixed', value: 8000 },
    });
    expect(t.discountTotal).toBe(5000);
    expect(t.grandTotal).toBe(0);
  });

  it('free shipping zeroes shipping only', () => {
    const t = calculateOrderTotals({
      lines: [{ unitPrice: 5000, quantity: 1 }],
      shipping: 800, taxRate: 0,
      promotion: { type: 'free_shipping', value: 0 },
    });
    expect(t.shippingTotal).toBe(0);
    expect(t.grandTotal).toBe(5000);
  });

  it('tax applies to the discounted subtotal', () => {
    const t = calculateOrderTotals({
      lines: [{ unitPrice: 10000, quantity: 1 }],
      shipping: 0, taxRate: 875, // 8.75%
    });
    expect(t.taxTotal).toBe(875);
    expect(t.grandTotal).toBe(10875);
  });
});
