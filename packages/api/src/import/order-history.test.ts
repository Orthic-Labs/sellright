import { describe, expect, it } from 'vitest';
import { migrationId } from './context.js';
import { assertSourceSchema, REQUIRED_SOURCE_COLUMNS, OPTIONAL_SOURCE_TABLES } from './source-schema.js';
import { buildImportedOrderHistory, classifyModification, type SourceModification, type SourceModificationReference,
  type SourceHistoryGraph, type TargetHistoryGraph } from './order-history.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const otherStoreId = '22222222-2222-4222-8222-222222222222';
const sourceKey = 'synthetic-history';
const id = (entity: string, sourceId: unknown) => migrationId(storeId, sourceKey, entity, sourceId);
const modification = (overrides: Partial<SourceModification> = {}): SourceModification => ({
  id: '1', sourceRecord: '{"id":1,"priceChange":-50,"unmappedAmount":900719925474099312345}',
  sourceOrderId: '10', sourcePaymentId: '20', sourceRefundId: '30',
  sourceCreatedAt: '2020-02-03 12:04:05.123456', sourceUpdatedAt: '2020-02-04 12:04:05.654321',
  priceChange: -50, note: 'Synthetic adjustment', shippingAddressChange: '{"city":"Test"}', billingAddressChange: null,
  ...overrides,
});
const reference = (pk: string, quantity: number): SourceModificationReference => ({ id: pk, modificationId: '1',
  orderLineId: '40', discriminator: 'OrderModificationLine',
  sourceRecord: `{"id":${pk},"quantity":${quantity},"opaque":900719925474099312345}` });
const graph = (): SourceHistoryGraph => ({
  orders: new Map([['10', { selected: true, hasChannel: true }], ['11', { selected: false, hasChannel: true }]]),
  lines: new Map([['40', '10']]), payments: new Map([['20', '10']]), refunds: new Map([['30', '20']]),
});
const target = (): TargetHistoryGraph => ({
  orders: new Map([[id('order', '10'), { id: id('order', '10'), storeId }]]),
  payments: new Map([[id('payment', '20'), { id: id('payment', '20'), storeId, orderId: id('order', '10') }]]),
  refunds: new Map([[id('refund', '30'), { id: id('refund', '30'), storeId, orderId: id('order', '10'), paymentId: id('payment', '20') }]]),
});
const build = (overrides: Partial<Parameters<typeof buildImportedOrderHistory>[0]> = {}) => buildImportedOrderHistory({
  storeId, sourceKey, id, modifications: [modification()], references: [reference('10', 0), reference('2', 3), reference('1', -4)],
  source: graph(), target: target(), ...overrides,
});

describe('retained imported order modifications', () => {
  it('preserves signed/zero deltas, exact large numeric text, microseconds & all source fields', () => {
    const result = build();
    const row = result.rows[0]!;
    expect(row.sourceRecord).toBe(modification().sourceRecord);
    expect(row.sourceReferences).toEqual([reference('1', -4).sourceRecord, reference('2', 3).sourceRecord, reference('10', 0).sourceRecord]);
    expect(row.sourceCreatedAt).toBe('2020-02-03 12:04:05.123456');
    expect(row.sourceUpdatedAt).toBe('2020-02-04 12:04:05.654321');
    expect(row.priceChange).toBe(-50);
    expect(row.shippingAddressChange).toBe(modification().shippingAddressChange);
    expect(row.orderId).toBe(id('order', '10'));
    expect(row.paymentId).toBe(id('payment', '20'));
    expect(row.refundId).toBe(id('refund', '30'));
    expect(result.exclusions).toEqual([]);
  });

  it('produces stable identities/content for reimport, ordered by numeric reference PK', () => {
    const first = build();
    const second = build({ references: [reference('2', 3), reference('1', -4), reference('10', 0)] });
    expect(second).toEqual(first);
    expect(first.rows[0]!.id).toBe(id('order-modification', '1'));
    expect(build({ references: [reference('1', -5)] }).rows[0]!.sourceDigest).not.toBe(first.rows[0]!.sourceDigest);
    expect(build({ modifications: [modification({ sourceRecord: modification().sourceRecord + ' ' })] }).rows[0]!.sourceDigest).not.toBe(first.rows[0]!.sourceDigest);
    expect(migrationId(otherStoreId, sourceKey, 'order-modification', '1')).not.toBe(first.rows[0]!.id);
  });

  it('retains every parent including note-only, address-only & unowned records without refs', () => {
    const result = build({ modifications: [modification(), modification({ id: '2', sourcePaymentId: null, sourceRefundId: null, note: '' }),
      modification({ id: '3', sourceOrderId: null, sourcePaymentId: null, sourceRefundId: null })], references: [] });
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.sourceReferences).toEqual([]);
    expect(result.rows[2]).toMatchObject({ scopeDisposition: 'unresolved_parent', orderId: null, paymentId: null, refundId: null });
    expect(result.exclusions[0]!.blocking).toBe(true);
  });

  it('derives owner only when all present edges agree & never invents source parent IDs', () => {
    const result = build({ modifications: [modification({ sourceOrderId: null })] });
    expect(result.rows[0]).toMatchObject({ sourceOrderId: null, orderId: id('order', '10'), scopeDisposition: 'selected_channel' });
    const conflict = build({ source: { ...graph(), lines: new Map([['40', '11']]) } });
    expect(conflict.rows[0]).toMatchObject({ scopeDisposition: 'unresolved_parent', orderId: null, paymentId: null, refundId: null });
    expect(conflict.exclusions[0]).toMatchObject({ blocking: true, detail: expect.stringContaining('contradictory') });
    const financialConflict = build({ source: { ...graph(), payments: new Map([['20', '10'], ['21', '10']]), refunds: new Map([['30', '21']]) } });
    expect(financialConflict.rows[0]).toMatchObject({ scopeDisposition: 'unresolved_parent', orderId: null, paymentId: null, refundId: null });
  });

  it('retains other-channel & broken-link records unattached; selected channel alone does not waive missing evidence', () => {
    const other = build({ modifications: [modification({ sourceOrderId: '11', sourcePaymentId: null, sourceRefundId: null })], references: [] });
    expect(other.rows[0]).toMatchObject({ scopeDisposition: 'other_channel', orderId: null, paymentId: null, refundId: null });
    expect(other.exclusions[0]!.blocking).toBe(false);
    const broken = build({ source: { ...graph(), refunds: new Map() } });
    expect(broken.rows[0]).toMatchObject({ scopeDisposition: 'unresolved_parent', orderId: null });
    expect(broken.exclusions[0]!.blocking).toBe(true);
    expect(classifyModification(modification(), [reference('1', -1)], { ...graph(), orders: new Map([['10', { selected: false, hasChannel: false }]]) }).scopeDisposition).toBe('unresolved_parent');
  });

  it('keeps unmapped financial/order links nullable & refuses cross-store or wrong-order target links', () => {
    const absent = build({ target: { ...target(), payments: new Map(), refunds: new Map() } });
    expect(absent.rows[0]).toMatchObject({ paymentId: null, refundId: null, sourcePaymentId: '20', sourceRefundId: '30' });
    expect(build({ target: { ...target(), orders: new Map() } }).rows[0]).toMatchObject({ orderId: null, paymentId: null, refundId: null });
    expect(() => build({ target: { ...target(), orders: new Map([[id('order', '10'), { id: id('order', '10'), storeId: otherStoreId }]]) } })).toThrow(/Cross-store/);
    expect(() => build({ target: { ...target(), payments: new Map([[id('payment', '20'), { id: id('payment', '20'), storeId: otherStoreId, orderId: id('order', '10') }]]) } })).toThrow(/financial link/);
    expect(() => build({ target: { ...target(), refunds: new Map([[id('refund', '30'), { id: id('refund', '30'), storeId, orderId: id('order', '11'), paymentId: id('payment', '20') }]]) } })).toThrow(/financial link/);
  });

  it('refuses parentless references & blocks unknown reference semantics without losing opaque facts', () => {
    expect(() => build({ references: [{ ...reference('1', -1), modificationId: '99' }] })).toThrow(/no retained parent/);
    expect(() => build({ references: [{ ...reference('1', -1), modificationId: null }] })).toThrow(/no retained parent/);
    const result = build({ references: [{ ...reference('1', -1), discriminator: 'UnknownLine' }] });
    expect(result.rows[0]!.sourceReferences).toEqual([reference('1', -1).sourceRecord]);
    expect(result.rows[0]!.orderId).toBeNull();
    expect(result.exclusions[0]!.blocking).toBe(true);
  });

  it('accepts absent history vintage, requires complete present parent/reference shape', () => {
    const columns = new Map(Object.entries(REQUIRED_SOURCE_COLUMNS).map(([table, names]) => [table, new Set(names)]));
    expect(() => assertSourceSchema(columns)).not.toThrow();
    columns.set('order_modification', new Set(OPTIONAL_SOURCE_TABLES.order_modification));
    expect(() => assertSourceSchema(columns)).toThrow(/modificationId/);
    columns.get('order_line_reference')!.add('modificationId');
    expect(() => assertSourceSchema(columns)).not.toThrow();
    columns.get('order_modification')!.delete('priceChange');
    expect(() => assertSourceSchema(columns)).toThrow(/priceChange/);
  });
});
