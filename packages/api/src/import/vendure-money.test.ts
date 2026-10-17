import { describe, expect, it } from 'vitest';
import { vendureLineMoney, vendureProratedUnitPriceWithTax, type VendureLineSnapshotInput } from './vendure-money.js';

describe('vendureLineMoney', () => {
  it('reconstructs item promotion and tax using Vendure rounding', () => {
    expect(vendureLineMoney({
      quantity: 2,
      orderPlacedQuantity: 2,
      listPrice: 1000,
      listPriceIncludesTax: false,
      adjustments: [{ type: 'PROMOTION', amount: -200 }],
      taxLines: [{ taxRate: 10 }],
    })).toEqual({
      unitPrice: 1000,
      lineSubtotal: 2000,
      lineDiscount: 200,
      lineTax: 180,
      lineTotal: 1980,
    });
  });

  it('extracts tax from tax-inclusive list prices', () => {
    expect(vendureLineMoney({
      quantity: 1,
      orderPlacedQuantity: 1,
      listPrice: 1100,
      listPriceIncludesTax: true,
      adjustments: [],
      taxLines: [{ taxRate: 10 }],
    })).toEqual({
      unitPrice: 1000,
      lineSubtotal: 1000,
      lineDiscount: 0,
      lineTax: 100,
      lineTotal: 1100,
    });
  });

  it('uses orderPlacedQuantity for distributed order promotions', () => {
    expect(vendureLineMoney({
      quantity: 1,
      orderPlacedQuantity: 3,
      listPrice: 1000,
      listPriceIncludesTax: false,
      adjustments: [{ type: 'DISTRIBUTED_ORDER_PROMOTION', amount: -300 }],
      taxLines: [],
    }).lineTotal).toBe(900);
  });

  it('uses placed quantity for every adjustment type after a partial cancellation', () => {
    expect(vendureLineMoney({
      quantity: 1,
      orderPlacedQuantity: 3,
      listPrice: 1000,
      listPriceIncludesTax: false,
      adjustments: [
        { type: 'PROMOTION', amount: -300 },
        { type: 'DISTRIBUTED_ORDER_PROMOTION', amount: -150 },
        { type: 'OTHER', amount: 30 },
      ],
      taxLines: [{ taxRate: 10 }],
    })).toEqual({ unitPrice: 1000, lineSubtotal: 1000, lineDiscount: 140, lineTax: 86, lineTotal: 946 });
  });

  it('uses current quantity when an edit increases quantity beyond placed quantity', () => {
    const snapshot: VendureLineSnapshotInput = {
      quantity: 4, orderPlacedQuantity: 2, listPrice: 1000, listPriceIncludesTax: false,
      adjustments: [{ type: 'PROMOTION', amount: -300 }], taxLines: [],
    };
    expect(vendureLineMoney(snapshot).lineTotal).toBe(3700);
    expect(vendureProratedUnitPriceWithTax(snapshot)).toBe(925);
  });

  it('ignores adjustments when all current units are cancelled, including added lines with no placed units', () => {
    for (const placed of [0, 3]) {
      const snapshot: VendureLineSnapshotInput = {
        quantity: 0, orderPlacedQuantity: placed, listPrice: 1100, listPriceIncludesTax: true,
        adjustments: [{ type: 'PROMOTION', amount: -300 }], taxLines: [{ taxRate: 10 }],
      };
      expect(vendureLineMoney(snapshot)).toEqual({ unitPrice: 1000, lineSubtotal: 0, lineDiscount: 0, lineTax: 0, lineTotal: 0 });
      expect(vendureProratedUnitPriceWithTax(snapshot)).toBe(1100);
    }
  });

  it('rounds cash-refund unit cents independently of the line projection', () => {
    const snapshot: VendureLineSnapshotInput = {
      quantity: 3, orderPlacedQuantity: 3, listPrice: 1000, listPriceIncludesTax: false,
      adjustments: [{ type: 'PROMOTION', amount: -100 }], taxLines: [],
    };
    expect(vendureLineMoney(snapshot).lineTotal).toBe(2900);
    const refundUnit = vendureProratedUnitPriceWithTax(snapshot);
    expect(refundUnit).toBe(967);
    expect(refundUnit * 2).toBe(1934);
    expect(refundUnit * 3).toBe(2901);
    expect(Math.round(vendureLineMoney(snapshot).lineTotal / 3 * 2)).toBe(1933);
  });

  it('preserves tax-inclusive and tax-exclusive cash-refund unit rounding', () => {
    const snapshot: VendureLineSnapshotInput = {
      quantity: 3, orderPlacedQuantity: 3, listPrice: 1000, listPriceIncludesTax: false,
      adjustments: [{ type: 'DISTRIBUTED_ORDER_PROMOTION', amount: -100 }], taxLines: [{ taxRate: 10 }],
    };
    expect(vendureProratedUnitPriceWithTax(snapshot)).toBe(1063);
    expect(vendureLineMoney(snapshot).lineTotal).toBe(3190);
    const inclusive = { ...snapshot, listPrice: 1100, listPriceIncludesTax: true };
    expect(vendureProratedUnitPriceWithTax(inclusive)).toBe(1067);
    expect(vendureLineMoney(inclusive).lineTotal).toBe(3200);
  });

  it('preserves the accounting identity for positive adjustments', () => {
    const out = vendureLineMoney({
      quantity: 1,
      orderPlacedQuantity: 1,
      listPrice: 1000,
      listPriceIncludesTax: false,
      adjustments: [{ type: 'OTHER', amount: 100 }],
      taxLines: [],
    });
    expect(out.lineSubtotal - out.lineDiscount + out.lineTax).toBe(out.lineTotal);
    expect(out.lineDiscount).toBe(-100);
  });
});
