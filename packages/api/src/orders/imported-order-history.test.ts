import { describe, expect, it } from 'vitest';
import type * as s from '../db/schema.js';
import { migrationId } from '../import/context.js';
import { projectImportedOrderHistory } from './imported-order-history.js';

const storeId = '30000000-0000-4000-8000-000000000001';
const orderId = '30000000-0000-4000-8000-000000000002';
const lineId = migrationId(storeId, 'source', 'order-line', '42');
type Row = typeof s.importedOrderModification.$inferSelect;
const row = (patch: Partial<Row> = {}): Row => ({
  id: '30000000-0000-4000-8000-000000000003', storeId, orderId,
  sourceKey: 'source', sourceId: '7', sourceDigest: 'private-digest', sourceRecord: '{"private":"raw-secret"}',
  sourceOrderId: 'private-order', sourceRefundId: 'private-refund', sourcePaymentId: 'private-payment',
  refundId: null, paymentId: null, scopeDisposition: 'selected_channel',
  sourceCreatedAt: '2024-04-03T11:22:33.123456', sourceUpdatedAt: '2024-04-04T11:22:33.123456',
  priceChange: -1200, note: 'Source note', sourceReferences: [], shippingAddressChange: null, billingAddressChange: null,
  ...patch,
});
const reference = (quantity: number, patch: Record<string, unknown> = {}) => JSON.stringify({
  discriminator: 'OrderModificationLine', modificationId: 7, orderLineId: 42, quantity, ...patch,
});
const context = {
  storeId, orderId, lines: [{ id: lineId, storeId, orderId, variantName: 'Widget' }],
  payments: [{ id: 'payment', storeId, orderId }], refunds: [{ id: 'refund', storeId, orderId }],
};

describe('imported order history display projection', () => {
  it('keeps signed & zero quantities, original timestamp text & explicit read-only semantics', () => {
    const [entry] = projectImportedOrderHistory([row({ sourceReferences: [reference(-2), reference(0), reference(3)] })], context);
    expect(entry).toMatchObject({ kind: 'imported', actionable: false, createdAt: null, updatedAt: null,
      sourceCreatedAtText: '2024-04-03T11:22:33.123456', sourceUpdatedAtText: '2024-04-04T11:22:33.123456', priceChange: -1200,
      lineChanges: [{ lineId, label: 'Widget', quantityDelta: -2 }, { quantityDelta: 0 }, { quantityDelta: 3 }] });
    expect(entry).not.toHaveProperty('settlement');
    expect(entry).not.toHaveProperty('grandTotalBefore');
    expect(entry).not.toHaveProperty('actor');
  });

  it('excludes wrong store/order, unresolved & other-channel records even if links are populated', () => {
    expect(projectImportedOrderHistory([
      row({ storeId: 'other' }), row({ orderId: 'other' }), row({ scopeDisposition: 'other_channel' }),
      row({ scopeDisposition: 'unresolved_parent' }), row({ orderId: null }),
    ], context)).toEqual([]);
  });

  it('only exposes line/payment/refund identities proven to belong to same order & store', () => {
    const foreign = { ...context, lines: [{ ...context.lines[0]!, storeId: 'other' }],
      payments: [{ id: 'payment', storeId, orderId: 'other' }], refunds: [{ id: 'refund', storeId: 'other', orderId }] };
    const input = row({ paymentId: 'payment', refundId: 'refund', sourceReferences: [reference(-1)] });
    expect(projectImportedOrderHistory([input], context)[0]).toMatchObject({ links: { paymentId: 'payment', refundId: 'refund' } });
    expect(projectImportedOrderHistory([input], foreign)[0]).toMatchObject({
      links: { paymentId: null, refundId: null }, lineChanges: [{ lineId: null, label: 'Imported order line', quantityDelta: -1 }],
    });
  });

  it('discards malformed/unrelated references without leaking source JSON or identifiers', () => {
    const [entry] = projectImportedOrderHistory([row({
      sourceReferences: ['bad json', '[]', 'null', reference(1, { modificationId: 8 }), reference(1, { discriminator: 'RefundLine' }),
        reference(1.5), reference(1, { orderLineId: Number.MAX_SAFE_INTEGER + 1 }), reference(0)],
      shippingAddressChange: '{bad', billingAddressChange: '{}',
    })], context);
    expect(entry?.lineChanges).toEqual([
      { lineId: null, label: 'Imported order line', quantityDelta: 1 }, { lineId, label: 'Widget', quantityDelta: 0 },
    ]);
    const wire = JSON.stringify(entry);
    for (const secret of ['raw-secret', 'private-order', 'private-refund', 'private-payment', 'private-digest', 'sourceReferences', 'sourceKey', 'modificationId']) {
      expect(wire).not.toContain(secret);
    }
    expect(entry?.addressChanges).toEqual({ shipping: null, billing: null });
  });

  it('whitelists address scalars & orders equal source timestamps by stable ID', () => {
    const rows = [row({ id: 'b', shippingAddressChange: JSON.stringify({ city: '<b>City</b>', secret: 'hidden', country: { token: 'secret' } }) }), row({ id: 'a' })];
    const entries = projectImportedOrderHistory(rows, context);
    expect(entries.map(entry => entry.id)).toEqual(['a', 'b']);
    expect(entries[1]?.addressChanges.shipping).toEqual({ fields: [{ label: 'City', value: '<b>City</b>' }] });
    expect(JSON.stringify(entries)).not.toContain('hidden');
  });
});
