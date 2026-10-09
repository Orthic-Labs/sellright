import { describe, expect, it } from 'vitest';
import {
  EditOp, OrderEditError, Settlement, allowedSettlements, applyEditOps, countryChanged, diffLines, lockedQty, normalizeAddress,
  openQty, priceWorkingOrder, readAddress, referencedKeys, validateSettlement,
  type EditLookups, type VariantFacts, type WLine, type WorkingOrder,
} from './order-edit.js';

const v = (sku: string, price: number, extra: Partial<VariantFacts> = {}): VariantFacts => ({
  id: `var-${sku}`, sku, name: `Widget ${sku}`, price, salePrice: null, isPreOrder: false, preOrderPrice: null,
  fulfillmentType: 'physical', enabled: true, productId: 'p1', ...extra,
});
const lookups = (): EditLookups => ({
  variantsBySku: new Map([v('A', 1000), v('B', 2000), v('OFF', 100, { enabled: false })].map((x) => [x.sku, x])),
  promosByCode: new Map([['TEN', { id: 'promo1', code: 'TEN', type: 'percentage' as const, value: 10, freeShipping: false, conditions: null }]]),
  methodsByCode: new Map([['std', { id: 'm1', code: 'std', name: 'Standard', calculator: { flat: 500 } }]]),
  unitPriceFor: (x) => x.price,
});
const line = (id: string, sku: string, quantity: number, extra: Partial<WLine> = {}): WLine => ({
  key: id, id, variantId: `var-${sku}`, sku, name: `Widget ${sku}`, unitPrice: sku === 'A' ? 1000 : 2000, quantity,
  fulfilledQty: 0, refundedQty: 0, cancelledQty: 0, original: { variantId: `var-${sku}`, sku, name: `Widget ${sku}`, unitPrice: sku === 'A' ? 1000 : 2000, quantity }, ...extra,
});
const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const base = (lines: WLine[]): WorkingOrder => ({ lines, adjustments: [], promotion: { kind: 'keep' }, shipping: { kind: 'keep' }, saveToAddressBook: false });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as OrderEditError).code; } return null; };

describe('applyEditOps', () => {
  it('set_quantity edits in place, preserving the row and never going below fulfilled + refunded', () => {
    const w = base([line(L1, 'A', 4, { fulfilledQty: 1, refundedQty: 1 })]);
    expect(lockedQty(w.lines[0]!)).toBe(2);
    expect(applyEditOps(w, [{ op: 'set_quantity', lineId: L1, quantity: 2 }], lookups()).lines[0]).toMatchObject({ id: L1, quantity: 2 });
    expect(code(() => applyEditOps(w, [{ op: 'set_quantity', lineId: L1, quantity: 1 }], lookups()))).toBe('LINE_LOCKED');
    // the input is never mutated
    expect(w.lines[0]!.quantity).toBe(4);
  });

  it('remove_line removes only unshipped/unrefunded units', () => {
    const w = base([line(L1, 'A', 4, { fulfilledQty: 1 }), line(L2, 'B', 2)]);
    const out = applyEditOps(w, [{ op: 'remove_line', lineId: L1 }, { op: 'remove_line', lineId: L2 }], lookups());
    expect(out.lines.map((l) => l.quantity)).toEqual([1, 0]);
    expect(code(() => applyEditOps(w, [{ op: 'remove_line', lineId: '33333333-3333-4333-8333-333333333333' }], lookups()))).toBe('LINE_NOT_FOUND');
  });

  it('add_item always appends a NEW row (optionally at a custom price); disabled variants are refused', () => {
    const out = applyEditOps(base([line(L1, 'A', 1)]), [{ op: 'add_item', sku: 'A', quantity: 2 }, { op: 'add_item', sku: 'B', quantity: 1, unitPrice: 5 }], lookups());
    expect(out.lines).toHaveLength(3);
    expect(out.lines[1]).toMatchObject({ id: null, quantity: 2, unitPrice: 1000 });
    expect(out.lines[2]).toMatchObject({ id: null, unitPrice: 5, customPrice: true });
    expect(code(() => applyEditOps(base([]), [{ op: 'add_item', sku: 'OFF', quantity: 1 }], lookups()))).toBe('VARIANT_UNAVAILABLE');
    expect(code(() => applyEditOps(base([]), [{ op: 'add_item', sku: 'NOPE', quantity: 1 }], lookups()))).toBe('VARIANT_UNAVAILABLE');
  });

  it('swap_variant re-points an untouched row, but splits when units are shipped', () => {
    const inPlace = applyEditOps(base([line(L1, 'A', 2)]), [{ op: 'swap_variant', lineId: L1, sku: 'B' }], lookups());
    expect(inPlace.lines).toHaveLength(1);
    expect(inPlace.lines[0]).toMatchObject({ id: L1, sku: 'B', unitPrice: 2000, quantity: 2 });
    const split = applyEditOps(base([line(L1, 'A', 3, { fulfilledQty: 1 })]), [{ op: 'swap_variant', lineId: L1, sku: 'B', quantity: 1 }], lookups());
    expect(split.lines.map((l) => [l.sku, l.quantity, l.id])).toEqual([['A', 2, L1], ['B', 1, null]]);
    expect(code(() => applyEditOps(base([line(L1, 'A', 3, { fulfilledQty: 3 })]), [{ op: 'swap_variant', lineId: L1, sku: 'B' }], lookups()))).toBe('LINE_LOCKED');
    expect(code(() => applyEditOps(base([line(L1, 'A', 3, { fulfilledQty: 1 })]), [{ op: 'swap_variant', lineId: L1, sku: 'B', quantity: 3 }], lookups()))).toBe('LINE_LOCKED');
  });

  it('coupon, shipping, adjustment and address ops stage their state', () => {
    const adjId = '44444444-4444-4444-8444-444444444444';
    const w: WorkingOrder = { ...base([]), adjustments: [{ id: adjId, label: 'old', amount: 5 }] };
    const out = applyEditOps(w, [
      { op: 'apply_coupon', code: 'TEN' }, { op: 'set_shipping_method', code: 'std' }, { op: 'add_adjustment', label: 'Goodwill', amount: -100 },
      { op: 'remove_adjustment', adjustmentId: adjId },
      { op: 'set_address', kind: 'shipping', address: { line1: '1 A St', city: 'X', country: 'CA' }, saveToAddressBook: true },
    ], lookups());
    expect(out.promotion).toMatchObject({ kind: 'apply' });
    expect(out.shipping).toMatchObject({ kind: 'method' });
    expect(out.adjustments).toEqual([{ id: null, label: 'Goodwill', amount: -100 }]);
    expect(out.shippingAddress?.country).toBe('CA');
    expect(out.saveToAddressBook).toBe(true);
    expect(applyEditOps(w, [{ op: 'set_shipping_amount', amount: 7 }], lookups()).shipping).toEqual({ kind: 'custom', amount: 7 });
    expect(applyEditOps(w, [{ op: 'remove_shipping' }], lookups()).shipping).toEqual({ kind: 'none' });
    expect(applyEditOps(w, [{ op: 'remove_coupon' }], lookups()).promotion).toEqual({ kind: 'none' });
    expect(code(() => applyEditOps(w, [{ op: 'apply_coupon', code: 'X' }], lookups()))).toBe('COUPON_NOT_FOUND');
    expect(code(() => applyEditOps(w, [{ op: 'remove_adjustment', adjustmentId: '55555555-5555-4555-8555-555555555555' }], lookups()))).toBe('ADJUSTMENT_NOT_FOUND');
  });

  it('schema validation: unknown op, zero adjustment, bad country', () => {
    expect(EditOp.safeParse({ op: 'nope' }).success).toBe(false);
    expect(EditOp.safeParse({ op: 'add_adjustment', label: 'x', amount: 0 }).success).toBe(false);
    expect(EditOp.safeParse({ op: 'set_address', kind: 'shipping', address: { line1: 'a', city: 'b', country: 'USA' } }).success).toBe(false);
    const ok = EditOp.parse({ op: 'set_address', kind: 'billing', address: { line1: ' a ', city: 'b', country: 'us' } });
    expect(ok.op === 'set_address' && ok.address.country).toBe('US');
  });

  it('referencedKeys lists skus / coupons / methods for pre-fetching', () => {
    expect(referencedKeys([{ op: 'add_item', sku: 'A', quantity: 1 }, { op: 'swap_variant', lineId: L1, sku: 'B' }, { op: 'apply_coupon', code: 'TEN' }, { op: 'set_shipping_method', code: 'std' }]))
      .toEqual({ skus: ['A', 'B'], coupons: ['TEN'], methods: ['std'] });
  });
});

describe('pricing + diff', () => {
  const pricing = { taxRate: 0, taxInclusive: false, shippingTaxable: false, promotion: null, pointsDiscount: 0, baseShipping: 500 };

  it('reprices through calculateOrderTotals; zero-quantity rows stay with zero money', () => {
    const lines = [line(L1, 'A', 2), line(L2, 'B', 0)];
    const p = priceWorkingOrder(lines, [{ id: null, label: 'x', amount: -250 }], pricing);
    expect(p.totals).toMatchObject({ subtotal: 2000, shippingTotal: 500, grandTotal: 2250, adjustmentTotal: -250 });
    expect(p.perLine).toEqual([{ key: L1, lineSubtotal: 2000, lineDiscount: 0, lineTotal: 2000 }, { key: L2, lineSubtotal: 0, lineDiscount: 0, lineTotal: 0 }]);
  });

  it('diffLines classifies added / removed / quantity / swapped / repriced / unchanged', () => {
    const before = [
      { id: L1, sku: 'A', name: 'A', unitPrice: 1000, quantity: 2, lineTotal: 2000, fulfilledQty: 0, refundedQty: 0 },
      { id: L2, sku: 'B', name: 'B', unitPrice: 2000, quantity: 1, lineTotal: 2000, fulfilledQty: 0, refundedQty: 0 },
    ];
    const working = applyEditOps(base([line(L1, 'A', 2), line(L2, 'B', 1)]), [{ op: 'set_quantity', lineId: L1, quantity: 3 }, { op: 'swap_variant', lineId: L2, sku: 'A' }, { op: 'add_item', sku: 'B', quantity: 1 }], lookups());
    const d = diffLines(before, working.lines, priceWorkingOrder(working.lines, [], pricing));
    expect(d.map((x) => x.change)).toEqual(['quantity', 'swapped', 'added']);
    expect(d[1]).toMatchObject({ fromSku: 'B', sku: 'A' });
    const removed = applyEditOps(base([line(L1, 'A', 2)]), [{ op: 'remove_line', lineId: L1 }], lookups());
    expect(diffLines([before[0]!], removed.lines, priceWorkingOrder(removed.lines, [], pricing))[0]!.change).toBe('removed');
  });
});

describe('settlement validation', () => {
  it('options follow the balance sign', () => {
    expect(allowedSettlements(-1)).toEqual(['refund_now', 'leave_credit']);
    expect(allowedSettlements(1)).toEqual(['send_pay_link', 'record_payment', 'leave_due']);
    expect(allowedSettlements(0)).toEqual([]);
  });
  it('balance 0 needs nothing and ignores any choice', () => {
    expect(validateSettlement(0, undefined)).toBeNull();
    expect(validateSettlement(0, { type: 'leave_due' })).toBeNull();
  });
  it('requires a valid choice; record_payment cannot exceed the balance', () => {
    expect(code(() => validateSettlement(500, undefined))).toBe('SETTLEMENT_REQUIRED');
    expect(code(() => validateSettlement(500, { type: 'refund_now' }))).toBe('SETTLEMENT_INVALID');
    expect(code(() => validateSettlement(-500, { type: 'send_pay_link' }))).toBe('SETTLEMENT_INVALID');
    expect(code(() => validateSettlement(500, { type: 'record_payment', method: 'cash', amount: 501 }))).toBe('SETTLEMENT_INVALID');
    expect(validateSettlement(500, { type: 'record_payment', method: 'cash', amount: 500 })).toMatchObject({ type: 'record_payment' });
    expect(Settlement.safeParse({ type: 'record_payment', method: 'venmo' }).success).toBe(false);
  });
});

describe('helpers', () => {
  it('openQty / readAddress / countryChanged', () => {
    expect(openQty({ quantity: 5, fulfilledQty: 2, cancelledQty: 1 })).toBe(2);
    expect(openQty({ quantity: 1, fulfilledQty: 3, cancelledQty: 0 })).toBe(0);
    const a = readAddress({ firstName: 'A', lastName: 'B', streetLine1: '1 X', city: 'C', countryCode: 'us', zip: '9' });
    expect(a).toMatchObject({ fullName: 'A B', line1: '1 X', country: 'US', postalCode: '9' });
    expect(countryChanged(a, normalizeAddress({ line1: 'q', city: 'w', country: 'CA' }))).toBe(true);
    expect(countryChanged(a, a)).toBe(false);
    expect(readAddress(null)).toBeNull();
  });
});
