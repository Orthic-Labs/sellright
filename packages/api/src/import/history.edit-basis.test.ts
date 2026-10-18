import { describe, expect, it } from 'vitest';
import { digest } from './artifacts.js';
import { migrationId } from './context.js';
import { buildImportedEditBasis, type EditBasisSourceChild, type EditBasisSourceLine, type EditBasisSourceOrder } from './history.js';

const storeId = '11111111-1111-4111-8111-111111111111', sourceKey = 'synthetic-edit-basis';
const id = (entity: string, source: unknown) => migrationId(storeId, sourceKey, entity, source);
const sourceRecord = '{"id":1,"subTotal":9007199254740993,"subTotalWithTax":9007199254740995,"shipping":101,"shippingWithTax":111,"customFieldsExact":0.1000000000000000001}';
function fixture() {
  const orders: EditBasisSourceOrder[] = [{ id: '1', selected: true, sourceRecord,
    subTotal: '9007199254740993', subTotalWithTax: '9007199254740995', shipping: '101', shippingWithTax: '111' }];
  const shippingLines: EditBasisSourceChild[] = [
    { id: '10', orderId: '1', sourceRecord: '{"id":10,"orderId":1,"listPrice":75,"shippingMethodId":6,"adjustments":[],"taxLines":[]}' },
    { id: '2', orderId: '1', sourceRecord: '{"id":2,"orderId":1,"listPrice":26,"shippingMethodId":5,"customFieldsLegacy":"raw"}' },
  ];
  const surcharges: EditBasisSourceChild[] = [{ id: '3', orderId: '1', sourceRecord: '{"id":3,"orderId":1,"listPrice":-7,"listPriceIncludesTax":true,"taxLines":[{"taxRate":9.75}]}' }];
  const lines: EditBasisSourceLine[] = [{ id: '10', orderId: '1', shippingLineId: '10',
    sourceRecord: '{"id":10,"orderId":1,"shippingLineId":10,"taxCategoryId":4,"listPrice":12345,"adjustments":[{"amount":-777}],"customFieldsExact":9007199254740993}' },
  { id: '2', orderId: '1', shippingLineId: null, sourceRecord: '{"id":2,"orderId":1,"shippingLineId":null,"taxCategoryId":null,"customFieldsVariant":"unchanged"}' }];
  const targetOrders = [{ id: id('order', '1'), storeId,
    metadata: { contact: { email: 'synthetic@example.invalid' }, vendure: { id: 1, sourceKey, state: 'Shipped', couponCodes: ['RAW'] } } }];
  const targetLines = lines.map(line => ({ id: id('order-line', line.id), storeId, orderId: targetOrders[0]!.id,
    metadata: { vendure: { id: Number(line.id), listPrice: 1 } } }));
  return { storeId, sourceKey, id, orders, lines, shippingLines, surcharges, targetOrders, targetLines };
}

describe('imported edit basis source capture', () => {
  it('retains raw LIST/header/shipping/surcharge/line evidence, with numeric identity order & source-bound digest', () => {
    const input = fixture(), original = structuredClone(input.targetOrders);
    const { orderId, editBasisV1 } = buildImportedEditBasis(input)[0]!;
    expect(orderId).toBe(id('order', '1'));
    expect(editBasisV1).toMatchObject({ version: 1, format: 'retained-pg-jsonb-text-v1', sourceKey, sourceOrderId: '1',
      sourceOrderRecord: sourceRecord, header: { subTotal: '9007199254740993', subTotalWithTax: '9007199254740995', shipping: '101', shippingWithTax: '111' },
      shippingLines: [input.shippingLines[1], input.shippingLines[0]].map(row => ({ sourceId: row!.id, sourceRecord: row!.sourceRecord })),
      surcharges: [{ sourceId: '3', sourceRecord: input.surcharges[0]!.sourceRecord }],
      lines: [input.lines[1], input.lines[0]].map(row => ({ sourceId: row!.id, orderLineId: id('order-line', row!.id), sourceRecord: row!.sourceRecord })) });
    const { sourceDigest, ...payload } = editBasisV1;
    expect(sourceDigest).toBe(digest(payload));
    expect(input.targetOrders).toEqual(original);
    expect(buildImportedEditBasis({ ...input, lines: [...input.lines].reverse(), shippingLines: [...input.shippingLines].reverse() })).toEqual([{ orderId, editBasisV1 }]);
  });

  it('preserves explicit null & empty evidence without residual or shipping-method inference', () => {
    const input = fixture();
    input.orders[0]!.shipping = null;
    input.orders[0]!.shippingWithTax = null;
    input.lines.forEach(line => { line.shippingLineId = null; });
    input.shippingLines = []; input.surcharges = [];
    const basis = buildImportedEditBasis(input)[0]!.editBasisV1;
    expect(basis.header.shipping).toBeNull(); expect(basis.header.shippingWithTax).toBeNull();
    expect(basis.shippingLines).toEqual([]); expect(basis.surcharges).toEqual([]);
    expect(basis).not.toHaveProperty('shippingMethodCode');
  });

  it('binds digest to source identity & every opaque source record', () => {
    const before = buildImportedEditBasis(fixture())[0]!.editBasisV1.sourceDigest;
    const changed = fixture(); changed.lines[0]!.sourceRecord += ' ';
    expect(buildImportedEditBasis(changed)[0]!.editBasisV1.sourceDigest).not.toBe(before);
    const other = fixture(); other.sourceKey = 'another-source';
    expect(() => buildImportedEditBasis(other)).toThrow(/source\/tenant/);
  });

  it('refuses missing source or target lines, duplicate IDs & unselected source ownership', () => {
    const absent = fixture(); absent.orders = [];
    expect(() => buildImportedEditBasis(absent)).toThrow(/ownership missing/);
    const missingTarget = fixture(); missingTarget.targetLines.pop();
    expect(() => buildImportedEditBasis(missingTarget)).toThrow(/line set differs/);
    const missingSource = fixture(); missingSource.lines.pop();
    expect(() => buildImportedEditBasis(missingSource)).toThrow(/line source\/tenant ownership/);
    const duplicate = fixture(); duplicate.shippingLines.push(duplicate.shippingLines[0]!);
    expect(() => buildImportedEditBasis(duplicate)).toThrow(/Duplicate/);
    const unselected = fixture(); unselected.orders[0]!.selected = false;
    expect(() => buildImportedEditBasis(unselected)).toThrow(/ownership missing/);
  });

  it('refuses cross-order/missing shipping relationships & source/tenant substitutions', () => {
    const missing = fixture(); missing.lines[0]!.shippingLineId = '999';
    expect(() => buildImportedEditBasis(missing)).toThrow(/shipping ownership/);
    const crossed = fixture();
    crossed.orders.push({ ...crossed.orders[0]!, id: '2', sourceRecord: '{"id":2}' });
    crossed.targetOrders.push({ ...crossed.targetOrders[0]!, id: id('order', '2'), metadata: {
      ...crossed.targetOrders[0]!.metadata, vendure: { ...crossed.targetOrders[0]!.metadata.vendure, id: 2 } } });
    crossed.shippingLines[0]!.orderId = '2';
    expect(() => buildImportedEditBasis(crossed)).toThrow(/shipping ownership/);
    const orphan = fixture(); orphan.surcharges[0]!.orderId = '999';
    expect(() => buildImportedEditBasis(orphan)).toThrow(/child ownership/);
    const tenant = fixture(); tenant.targetOrders[0]!.storeId = 'another-store';
    expect(() => buildImportedEditBasis(tenant)).toThrow(/source\/tenant/);
    const wrongLineOrder = fixture(); wrongLineOrder.targetLines[0]!.orderId = 'another-order';
    expect(() => buildImportedEditBasis(wrongLineOrder)).toThrow(/line source\/tenant ownership/);
    const old = fixture(); delete (old.targetOrders[0]!.metadata.vendure as { sourceKey?: string }).sourceKey;
    expect(() => buildImportedEditBasis(old)).toThrow(/source\/tenant/);
  });
});
