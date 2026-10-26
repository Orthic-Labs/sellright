import { describe, expect, it } from 'vitest';
import { dataRowCount, dryRunResult, importResult, inferProvider, openOrderStatus } from './fulfilment';
import type { PreviewRow } from './tracking';

const row = (over: Partial<PreviewRow>): PreviewRow => ({ index: 0, code: 'DD1', tracking: 'T', carrier: 'USPS', carrierSource: 'detected', status: 'ready', message: '', items: [], customerEmail: 'a@b.co', ...over });
const parse = { titleSkipped: true, header: ['Owner', 'OrderId', 'shpack_trackingid'], columns: { order: 'OrderId', tracking: 'shpack_trackingid', carrier: null },
  skipped: { blank: 0, amazon: 1, duplicate: 0 }, skippedRows: [{ line: 3, code: '111-0237367-7778662', tracking: '9400150106151447202527', reason: 'amazon' as const }] };

describe('fulfilment pages (#380, previous admin parity)', () => {
  it('infers the carrier with the previous admin rules', () => {
    expect(inferProvider('9400111899223817200001')).toBe('USPS');
    expect(inferProvider('312345678901')).toBe('FedEx');
    expect(inferProvider('1Z999AA10123456784')).toBe('UPS');
    expect(inferProvider('ABC')).toBe('');
  });

  it('dry run: the previous admin messages, plus the rows the file parser left out as skipped', () => {
    const r = dryRunResult({ rows: [
      row({ code: 'DD30331', tracking: '9400111899223817200001' }),
      row({ code: 'DD9', status: 'unknown_order', message: 'no order DD9' }),
      row({ code: 'DD8', status: 'nothing_to_ship', message: 'already delivered' }),
      row({ code: 'DD7', status: 'already_shipped', message: 'same tracking already on this order' }),
      row({ code: 'DD6', status: 'not_shippable', message: 'Imported order needs reconciliation' }),
      row({ code: 'DD5', carrier: null, tracking: 'X1' }),
    ], summary: { total: 6, importable: 2, byStatus: {} }, parse });
    expect(r.details).toEqual([
      { orderCode: 'DD30331', status: 'success', message: 'Would ship with USPS: 9400111899223817200001' },
      { orderCode: 'DD9', status: 'skipped', message: 'Order not found' },
      { orderCode: 'DD8', status: 'skipped', message: 'Already Delivered' },
      { orderCode: 'DD7', status: 'skipped', message: 'Already Shipped' },
      { orderCode: 'DD6', status: 'error', message: 'Imported order needs reconciliation' },
      { orderCode: 'DD5', status: 'success', message: 'Would ship with Standard Shipping: X1' },
      { orderCode: '111-0237367-7778662', status: 'skipped', message: 'Amazon order' },
    ]);
    expect([r.success, r.skipped, r.errors, r.emailsSent]).toEqual([2, 4, 1, 0]);
  });

  it('an all-Amazon file (the real Avid sample) is one skipped row, nothing else', () => {
    expect(dryRunResult({ rows: [], summary: { total: 0, importable: 0, byStatus: {} }, parse })).toEqual({
      success: 0, errors: 0, skipped: 1, emailsSent: 0, details: [{ orderCode: '111-0237367-7778662', status: 'skipped', message: 'Amazon order' }],
    });
  });

  it('execute: shipped rows with the email flag, counts from the server', () => {
    const r = importResult({ updated: 1, skipped: 1, emailsQueued: 1, batchId: 'b', errors: [], parse: null, rows: [
      { ...row({ code: 'DD1', tracking: '1Z999AA10123456784', carrier: 'UPS' }), imported: true },
      { ...row({ code: 'DD2', status: 'unknown_order' }), imported: false },
    ] });
    expect(r).toEqual({ success: 1, errors: 0, skipped: 1, emailsSent: 1, details: [
      { orderCode: 'DD1', status: 'success', message: 'Shipped with UPS: 1Z999AA10123456784', emailSent: true },
      { orderCode: 'DD2', status: 'skipped', message: 'Order not found' },
    ] });
  });

  it('open-order status labels and the data-row count', () => {
    expect(openOrderStatus({ state: 'Paid', fulfillmentStatus: 'unfulfilled' })).toBe('Processing');
    expect(openOrderStatus({ state: 'Paid', fulfillmentStatus: 'partially_fulfilled' })).toBe('Part. Shipped');
    expect(openOrderStatus({ state: 'Paid', isPreOrder: true, fulfillmentStatus: 'unfulfilled' })).toBe('Pre-ordered');
    expect(openOrderStatus({ state: 'PartiallyRefunded', fulfillmentStatus: 'unfulfilled' })).toBe('Refunded');
    expect(dataRowCount('title\r\nheader\r\nrow1\r\n\r\n')).toBe(2);
  });
});
