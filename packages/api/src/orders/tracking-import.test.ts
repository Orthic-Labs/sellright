import { describe, expect, it } from 'vitest';
import { classifyTrackingRow, levenshtein, normalizeOrderCode, parseTrackingCsv, precheckRow, resolveCarrier, suggestOrderCode, type OrderFacts } from './tracking-import.js';

const facts = (over: Partial<OrderFacts> = {}): OrderFacts => ({
  state: 'Paid', deleted: false,
  lines: [{ sku: 'KNF-1', name: 'Knife', quantity: 2, fulfilledQty: 0, cancelledQty: 0 }],
  fulfillments: [], ...over,
});

describe('classifyTrackingRow', () => {
  it('ships remaining items when paid and unfulfilled', () => {
    const v = classifyTrackingRow('1Z999AA10123456784', facts());
    expect(v.status).toBe('ready');
    expect(v.items).toEqual([{ sku: 'KNF-1', name: 'Knife', quantity: 2 }]);
  });
  it('ships only the remaining quantity on a partially fulfilled order', () => {
    const v = classifyTrackingRow('T2', facts({ lines: [{ sku: 'A', name: 'A', quantity: 3, fulfilledQty: 1, cancelledQty: 0 }], fulfillments: [{ state: 'Shipped', trackingCode: 'T1' }] }));
    expect(v.status).toBe('ready');
    expect(v.items[0]!.quantity).toBe(2);
  });
  it('flags the same tracking number as already shipped (case-insensitive)', () => {
    const v = classifyTrackingRow('abc123', facts({ fulfillments: [{ state: 'Shipped', trackingCode: 'ABC123' }] }));
    expect(v.status).toBe('already_shipped');
  });
  it('treats a fully shipped order with a new number as a tracking update', () => {
    const v = classifyTrackingRow('NEW', facts({ lines: [{ sku: 'A', name: 'A', quantity: 1, fulfilledQty: 1, cancelledQty: 0 }], fulfillments: [{ state: 'Shipped', trackingCode: 'OLD' }] }));
    expect(v.status).toBe('update_tracking');
  });
  it('rejects unpaid, cancelled and trashed orders', () => {
    expect(classifyTrackingRow('T', facts({ state: 'PendingPayment' })).message).toBe('not paid yet');
    expect(classifyTrackingRow('T', facts({ state: 'Cancelled' })).status).toBe('not_shippable');
    expect(classifyTrackingRow('T', facts({ deleted: true })).status).toBe('not_shippable');
  });
  it('does not regress a delivered order', () => {
    const v = classifyTrackingRow('X', facts({ lines: [{ sku: 'A', name: 'A', quantity: 1, fulfilledQty: 1, cancelledQty: 0 }], fulfillments: [{ state: 'Delivered', trackingCode: 'OLD' }] }));
    expect(v.status).toBe('nothing_to_ship');
  });
});

describe('row helpers', () => {
  it('prechecks empty cells', () => {
    expect(precheckRow('', 'T')!.status).toBe('missing_code');
    expect(precheckRow('DD1', '')!.status).toBe('missing_tracking');
    expect(precheckRow('DD1', 'T')).toBeNull();
  });
  it('normalizes codes', () => { expect(normalizeOrderCode(' #dd30284 ')).toBe('DD30284'); });
  it('detects or honours carrier', () => {
    expect(resolveCarrier({ code: 'A', tracking: '1Z999AA10123456784' })).toEqual({ carrier: 'UPS', source: 'detected' });
    expect(resolveCarrier({ code: 'A', tracking: 'X', carrier: 'DHL' })).toEqual({ carrier: 'DHL', source: 'given' });
    expect(resolveCarrier({ code: 'A', tracking: 'X' }).source).toBe('unknown');
  });
  it('suggests the nearest order code', () => {
    expect(levenshtein('DD30285', 'DD30284')).toBe(1);
    expect(suggestOrderCode('DD30285', ['DD30284', 'DD30100'])).toBe('DD30284');
    expect(suggestOrderCode('ZZ99999', ['DD30284'])).toBeNull();
    expect(suggestOrderCode('DD30284', ['DD30284'])).toBeNull(); // exact match is not a suggestion
  });
});

describe('parseTrackingCsv', () => {
  it('parses a headered CSV with quotes and optional carrier', () => {
    const rows = parseTrackingCsv('Order,Tracking Number,Carrier\nDD1,"9400 1118 9922",USPS\nDD2,1Z999AA10123456784,\n');
    expect(rows).toEqual([
      { code: 'DD1', tracking: '9400 1118 9922', carrier: 'USPS' },
      { code: 'DD2', tracking: '1Z999AA10123456784', carrier: undefined },
    ]);
  });
  it('parses headerless tab and semicolon rows', () => {
    expect(parseTrackingCsv('DD1\tT1')).toEqual([{ code: 'DD1', tracking: 'T1', carrier: undefined }]);
    expect(parseTrackingCsv('DD1;T1;UPS')[0]!.carrier).toBe('UPS');
  });
  it('honours reordered headers', () => {
    expect(parseTrackingCsv('tracking,order\nT9,DD9')).toEqual([{ code: 'DD9', tracking: 'T9', carrier: undefined }]);
  });
});
