import { describe, expect, it } from 'vitest';
import { vendureExactLineMoney, vendureOrderChargeProjection, vendureShippingMoney, vendureSourceRecord,
  vendureSurchargeMoney } from './order-charges.js';

const line = (overrides: Record<string, unknown> = {}) => ({ quantity: '3', orderPlacedQuantity: '3', listPrice: '101',
  listPriceIncludesTax: false, adjustments: '[{"amount":-4,"type":"PROMOTION"}]', taxLines: '[{"taxRate":20}]', ...overrides });
const charge = (overrides: Record<string, unknown> = {}) => ({ id: '8', description: 'Historical fee', listPrice: '101',
  listPriceIncludesTax: true, taxLines: '[{"taxRate":20}]', ...overrides });
const shipping = (overrides: Record<string, unknown> = {}) => ({ id: '9', listPrice: '101', listPriceIncludesTax: true,
  adjustments: '[{"amount":-5}]', taxLines: '[{"taxRate":20}]', ...overrides });

describe('source charge getters', () => {
  it('keeps positive & negative surcharge rounding separately before aggregate', () => {
    const positive = vendureSurchargeMoney(charge());
    const negative = vendureSurchargeMoney(charge({ id: '10', listPrice: '-100' }));
    expect(positive).toEqual({ sourceId: '8', label: 'Historical fee', net: 84, gross: 101 });
    expect(negative).toEqual({ sourceId: '10', label: 'Historical fee', net: -83, gross: -100 });
    expect(positive.net + negative.net).toBe(1);
    expect(Math.round((101 - 100) / 1.2)).toBe(1);
    const p = vendureSurchargeMoney(charge({ listPrice: '3', taxLines: '[{"taxRate":100}]' }));
    const n = vendureSurchargeMoney(charge({ id: '10', listPrice: '-1', taxLines: '[{"taxRate":100}]' }));
    expect(p.net + n.net).toBe(2); // aggregate-then-round would lose one cent
  });

  it('uses independent discounted shipping lines, including shipping credits', () => {
    expect(vendureShippingMoney(shipping())).toEqual({ sourceId: '9', net: 80, gross: 96 });
    expect(vendureShippingMoney(shipping({ id: '10', listPrice: '-100', listPriceIncludesTax: false,
      adjustments: '[{"amount":-1}]' }))).toEqual({ sourceId: '10', net: -101, gross: -121 });
  });

  it('preserves exact line quantity & placed zero without expanding units', () => {
    const result = vendureExactLineMoney(line({ orderPlacedQuantity: '0' }));
    expect(result.placedQuantity).toBe(0);
    expect(result.quantity).toBe(3);
    expect(result.money).toEqual({ unitPrice: 101, lineSubtotal: 303, lineDiscount: 4, lineTax: 60, lineTotal: 359 });
    expect(vendureExactLineMoney(line({ quantity: '0', orderPlacedQuantity: '0' })).money.lineTotal).toBe(0);
  });

  it.each([
    { quantity: '1.5' }, { quantity: '-1' }, { orderPlacedQuantity: '-1' }, { quantity: '9007199254740993' },
    { listPrice: '9007199254740993' }, { listPriceIncludesTax: 'false' },
    { adjustments: '[{"amount":9007199254740993}]' }, { adjustments: '[{"amount":null}]' },
    { taxLines: '[{"taxRate":0.100000000000000001}]' }, { taxLines: '[{"taxRate":-100}]' },
  ])('rejects invalid exact source money before projection: %j', overrides => {
    expect(() => vendureExactLineMoney(line(overrides))).toThrow();
  });

  it('preserves unsafe raw JSON numbers as lexemes until validation', () => {
    const raw = vendureSourceRecord('{"id":8,"description":"Fee","listPrice":9007199254740993,"listPriceIncludesTax":false,"taxLines":[]}');
    expect(raw.listPrice).toBe('9007199254740993');
    expect(() => vendureSurchargeMoney(raw)).toThrow(/Unsafe/);
  });
});

describe('complete source order reconciliation', () => {
  const rows = () => ({ lines: [vendureExactLineMoney(line()).money],
    surcharges: [vendureSurchargeMoney(charge()), vendureSurchargeMoney(charge({ id: '10', listPrice: '-50', listPriceIncludesTax: false }))],
    shipping: [vendureShippingMoney(shipping()), vendureShippingMoney(shipping({ id: '11', listPrice: '10', adjustments: '[]', listPriceIncludesTax: false }))] });
  // M=(299,359), S=(34,41), H=(90,108).
  const header = { subTotal: 333, subTotalWithTax: 400, shipping: 90, shippingWithTax: 108 };
  it('matches all four headers & native accounting identity with explicit signed charges', () => {
    const result = vendureOrderChargeProjection({ ...rows(), header });
    expect(result.status).toBe('exact-header');
    expect(result.expected).toEqual(header);
    expect(result.adjustmentTotal).toBe(34);
    expect(result.totals).toEqual({ subtotal: 303, discountTotal: 4, shippingTotal: 90, taxTotal: 85, grandTotal: 508 });
    expect(result.totals.subtotal - result.totals.discountTotal + result.totals.shippingTotal + result.totals.taxTotal + result.adjustmentTotal).toBe(508);
  });
  it('corroborates stale headers only against full expected signed grand', () => {
    const stale = { ...header, subTotalWithTax: 1, shippingWithTax: 900 };
    expect(vendureOrderChargeProjection({ ...rows(), header: stale, netSettled: 508 }).status).toBe('settled-corroborated');
    expect(vendureOrderChargeProjection({ ...rows(), header: stale, netSettled: 467 }).status).toBe('unresolved');
    expect(vendureOrderChargeProjection({ ...rows(), header: stale }).status).toBe('unresolved');
  });
  it('does not absorb contradictory net headers or shipping into tax', () => {
    for (const key of Object.keys(header) as Array<keyof typeof header>) {
      expect(vendureOrderChargeProjection({ ...rows(), header: { ...header, [key]: header[key] + 1 } }).status).toBe('unresolved');
    }
  });
  it('preserves a signed grand total', () => {
    const result = vendureOrderChargeProjection({ lines: [], shipping: [],
      surcharges: [vendureSurchargeMoney(charge({ listPrice: '-101', listPriceIncludesTax: false }))],
      header: { subTotal: -101, subTotalWithTax: -121, shipping: 0, shippingWithTax: 0 } });
    expect(result.status).toBe('exact-header');
    expect(result.totals.grandTotal).toBe(-121);
  });
});
