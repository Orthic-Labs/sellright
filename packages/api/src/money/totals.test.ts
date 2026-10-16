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

  it('R24: a percentage promotion can ALSO waive shipping via freeShipping', () => {
    const t = calculateOrderTotals({
      lines: [{ unitPrice: 7201, quantity: 1 }],
      shipping: 800, taxRate: 0,
      promotion: { type: 'percentage', value: 10, freeShipping: true },
    });
    expect(t.discountTotal).toBe(720); // the percentage discount still applies
    expect(t.shippingTotal).toBe(0); // AND shipping is waived
    expect(t.grandTotal).toBe(7201 - 720);
  });

  it('R24: a fixed promotion with freeShipping:false still charges shipping', () => {
    const t = calculateOrderTotals({
      lines: [{ unitPrice: 5000, quantity: 1 }],
      shipping: 800, taxRate: 0,
      promotion: { type: 'fixed', value: 1000, freeShipping: false },
    });
    expect(t.shippingTotal).toBe(800);
    expect(t.grandTotal).toBe(5000 - 1000 + 800);
  });

  it('tax applies to the discounted subtotal', () => {
    const t = calculateOrderTotals({
      lines: [{ unitPrice: 10000, quantity: 1 }],
      shipping: 0, taxRate: 875, // 8.75%
    });
    expect(t.taxTotal).toBe(875);
    expect(t.grandTotal).toBe(10875);
  });

  it('includes shipping in tax basis only when configured', () => {
    const untaxedShipping = calculateOrderTotals({
      lines: [{ unitPrice: 10000, quantity: 1 }],
      shipping: 1000, taxRate: 1000, shippingTaxable: false,
    });
    const taxedShipping = calculateOrderTotals({
      lines: [{ unitPrice: 10000, quantity: 1 }],
      shipping: 1000, taxRate: 1000, shippingTaxable: true,
    });

    expect(untaxedShipping.taxTotal).toBe(1000);
    expect(untaxedShipping.grandTotal).toBe(12000);
    expect(taxedShipping.taxTotal).toBe(1100);
    expect(taxedShipping.grandTotal).toBe(12100);
  });

  // HARDENING FIX 2: percentage promotion value must never be able to drive a
  // negative order total. The admin API boundary (admin-marketing.ts) should
  // reject a >100% percentage promo before it ever reaches the DB, but this is
  // the defensive floor for a bad pre-existing row.
  it('a 150% percentage promo does not produce a negative total (defensive clamp)', () => {
    const t = calculateOrderTotals({
      lines: [{ unitPrice: 5000, quantity: 1 }],
      shipping: 0, taxRate: 0,
      promotion: { type: 'percentage', value: 150 },
    });
    // Clamped to 100%: full line discount, never more than the subtotal.
    expect(t.discountTotal).toBe(5000);
    expect(t.grandTotal).toBe(0);
    expect(t.grandTotal).toBeGreaterThanOrEqual(0);
  });

  it('a negative percentage promo value is clamped to 0 (no discount, no negative total)', () => {
    const t = calculateOrderTotals({
      lines: [{ unitPrice: 5000, quantity: 1 }],
      shipping: 0, taxRate: 0,
      promotion: { type: 'percentage', value: -50 },
    });
    expect(t.discountTotal).toBe(0);
    expect(t.grandTotal).toBe(5000);
  });
});

describe('calculateOrderTotals — order-edit adjustments (G13)', () => {
  const lines = [{ unitPrice: 10000, quantity: 1 }];
  it('is byte-identical when no adjustments are passed', () => {
    const t = calculateOrderTotals({ lines, shipping: 500, taxRate: 875 });
    expect(Object.keys(t)).not.toContain('adjustmentTotal');
    expect(calculateOrderTotals({ lines, shipping: 500, taxRate: 875, adjustments: [] }).grandTotal).toBe(t.grandTotal);
  });
  it('adds a signed, untaxed amount to the grand total (tax unchanged)', () => {
    const base = calculateOrderTotals({ lines, shipping: 500, taxRate: 875 });
    const t = calculateOrderTotals({ lines, shipping: 500, taxRate: 875, adjustments: [{ label: 'fee', amount: 300 }, { label: 'credit', amount: -100 }] });
    expect(t.adjustmentTotal).toBe(200);
    expect(t.taxTotal).toBe(base.taxTotal);
    expect(t.grandTotal).toBe(base.grandTotal + 200);
  });
  it('a taxable adjustment joins the taxable base', () => {
    const t = calculateOrderTotals({ lines, shipping: 0, taxRate: 1000, adjustments: [{ amount: 1000, taxable: true }] });
    expect(t.taxTotal).toBe(1100);
    expect(t.grandTotal).toBe(10000 + 1000 + 1100);
  });
  it('works with tax-inclusive pricing and method-specific shipping tax', () => {
    const inc = calculateOrderTotals({ lines, shipping: 0, taxRate: 1000, taxInclusive: true, adjustments: [{ amount: -500 }] });
    expect(inc.grandTotal).toBe(9500);
    const ship = calculateOrderTotals({ lines, shipping: 1000, taxRate: 1000, shippingTaxRate: 500, adjustments: [{ amount: 250 }] });
    expect(ship.grandTotal).toBe(10000 + 1000 + 1000 + 50 + 250);
  });
  it('the grand total never goes negative', () => {
    expect(calculateOrderTotals({ lines, shipping: 0, taxRate: 0, adjustments: [{ amount: -50000 }] }).grandTotal).toBe(0);
  });
});
