import { describe, expect, it } from 'vitest';
import { allocateEditRefundLines, applyEditOps, priceWorkingOrder, removedUnits, type EditLookups, type LineSnap, type WLine, type WorkingOrder } from './order-edit.js';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const line = (id: string, sku: string, quantity: number, extra: Partial<WLine> = {}): WLine => ({
  key: id, id, variantId: `var-${sku}`, sku, name: `Widget ${sku}`, unitPrice: sku === 'A' ? 1000 : 2000, quantity,
  fulfilledQty: 0, refundedQty: 0, cancelledQty: 0, editRemovedQty: 0, original: { variantId: `var-${sku}`, sku, name: `Widget ${sku}`, unitPrice: sku === 'A' ? 1000 : 2000, quantity }, ...extra,
});
const order = (lines: WLine[]): WorkingOrder => ({ lines, adjustments: [], couponCodes: [], promotion: { kind: 'keep' }, shipping: { kind: 'keep' }, saveToAddressBook: false });
const price = (lines: WLine[]) => priceWorkingOrder(lines, [], { taxRate: 0, taxInclusive: false, shippingTaxable: false, promotion: null, pointsDiscount: 0, baseShipping: 0 });
const snaps = (lines: WLine[]): LineSnap[] => {
  const p = price(lines);
  return lines.map((l) => ({ id: l.id, sku: l.sku, name: l.name, unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: p.perLine.find((x) => x.key === l.key)!.lineTotal, fulfilledQty: l.fulfilledQty, refundedQty: l.refundedQty }));
};
const lookups = (): EditLookups => ({ variantsBySku: new Map(), promosByCode: new Map(), methodsByCode: new Map(), unitPriceFor: (x) => x.price });

describe('removedUnits', () => {
  const before = [line(L1, 'A', 2), line(L2, 'B', 1)];
  const run = (ops: Parameters<typeof applyEditOps>[1]) => {
    const w = applyEditOps(order(before), ops, lookups());
    return removedUnits(snaps(before), w.lines, price(w.lines));
  };

  it('reports whole units removed per line with the line money they carried', () => {
    expect(run([{ op: 'set_quantity', lineId: L1, quantity: 1 }])).toEqual([{ orderLineId: L1, sku: 'A', quantity: 1, amount: 1000 }]);
    expect(run([{ op: 'remove_line', lineId: L2 }])).toEqual([{ orderLineId: L2, sku: 'B', quantity: 1, amount: 2000 }]);
    expect(run([{ op: 'remove_line', lineId: L1 }, { op: 'remove_line', lineId: L2 }]).map((u) => [u.sku, u.quantity, u.amount])).toEqual([['A', 2, 2000], ['B', 1, 2000]]);
  });

  it('reports nothing for price, shipping, adjustment or quantity-increase edits', () => {
    expect(run([{ op: 'set_shipping_amount', amount: 0 }])).toEqual([]);
    expect(run([{ op: 'add_adjustment', label: 'Goodwill', amount: -300 }])).toEqual([]);
    expect(run([{ op: 'set_quantity', lineId: L1, quantity: 5 }])).toEqual([]);
  });

  it('only counts units still open: a shipped unit is locked and never removed', () => {
    const shipped = [line(L1, 'A', 3, { fulfilledQty: 1 })];
    const w = applyEditOps(order(shipped), [{ op: 'remove_line', lineId: L1 }], lookups());
    expect(removedUnits(snaps(shipped), w.lines, price(w.lines))).toEqual([{ orderLineId: L1, sku: 'A', quantity: 2, amount: 2000 }]);
  });
});

describe('allocateEditRefundLines', () => {
  const units = [
    { orderLineId: L2, sku: 'B', quantity: 1, amount: 2000 },
    { orderLineId: L1, sku: 'A', quantity: 1, amount: 1000 },
  ];
  it('books the removed value as items and orders lines deterministically', () => {
    expect(allocateEditRefundLines(units, 3000)).toEqual({ lines: [{ orderLineId: L1, quantity: 1, amount: 1000 }, { orderLineId: L2, quantity: 1, amount: 2000 }], itemsAmount: 3000 });
  });
  it('a refund larger than the removed value leaves the rest as an adjustment (items never exceed removed value)', () => {
    expect(allocateEditRefundLines(units, 3500).itemsAmount).toBe(3000);
  });
  it('a refund smaller than the removed value never attributes more than was refunded', () => {
    const out = allocateEditRefundLines(units, 1500);
    expect(out.itemsAmount).toBe(1500);
    expect(out.lines).toEqual([{ orderLineId: L1, quantity: 1, amount: 1000 }, { orderLineId: L2, quantity: 1, amount: 500 }]);
  });
  it('no removed units -> no lines (a price-only refund is all adjustment)', () => {
    expect(allocateEditRefundLines([], 500)).toEqual({ lines: [], itemsAmount: 0 });
  });
});

describe('swap_variant on a line an earlier edit already reduced', () => {
  it('does not re-point the row (its edit-removed units belong to the old variant); it splits instead', () => {
    const w = applyEditOps(order([line(L1, 'A', 1, { editRemovedQty: 1 })]), [{ op: 'swap_variant', lineId: L1, sku: 'B' }], {
      ...lookups(), variantsBySku: new Map([['B', { id: 'var-B', sku: 'B', name: 'Widget B', price: 2000, salePrice: null, isPreOrder: false, preOrderPrice: null, fulfillmentType: 'physical', enabled: true, productId: 'p1' }]]),
    });
    expect(w.lines.map((l) => [l.sku, l.quantity, l.id])).toEqual([['A', 0, L1], ['B', 1, null]]);
  });
});
