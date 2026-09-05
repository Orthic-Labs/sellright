import { describe, expect, it } from 'vitest';
import { vendureLineMoney } from './vendure-money.js';

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
