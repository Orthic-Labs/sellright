import { describe, expect, it } from 'vitest';
import { migrationId } from './context.js';
import { orderEditStoredFingerprint } from '../orders/order-edit-stack.js';
import { readImportedOrderEditBasis, readImportedOrderEditComponents } from './order-edit-basis.js';
const A = 'cccccccc-0000-4000-8000-000000000001';
const B = 'cccccccc-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
describe('retained imported order edit basis', () => {
  it('admits imported raw LIST only through complete digest/ownership/getter parity', () => {
    const orderId = migrationId(C, 'source', 'order', 9), lineId = migrationId(C, 'source', 'order-line', 7);
    const sourceLine = { id: 7, orderId: 9, quantity: 2, orderPlacedQuantity: 3, listPrice: 120, listPriceIncludesTax: true,
      adjustments: [{ amount: -60, type: 'PROMOTION' }], taxLines: [{ taxRate: 20 }], shippingLineId: null };
    const payload = { version: 1, format: 'retained-pg-jsonb-text-v1', sourceKey: 'source', sourceOrderId: '9',
      sourceOrderRecord: JSON.stringify({ id: 9, currencyCode: 'USD', subTotal: 167, subTotalWithTax: 200, shipping: 0, shippingWithTax: 0, couponCodes: ['EXPIRED'] }),
      channel: { sourceId: '3', projection: 'pricing-v1', sourceRecord: JSON.stringify({ id: 3, defaultCurrencyCode: 'USD', pricesIncludeTax: true, defaultTaxZoneId: 1 }), orderChannelRecord: JSON.stringify({ orderId: 9, channelId: 3 }) },
      header: { subTotal: '167', subTotalWithTax: '200', shipping: '0', shippingWithTax: '0' },
      lines: [{ sourceId: '7', orderLineId: lineId, sourceRecord: JSON.stringify(sourceLine) }], shippingLines: [], shippingMethods: [], surcharges: [] };
    const metadata = { vendure: { id: 9, sourceKey: 'source', editBasisV1: { ...payload, sourceDigest: orderEditStoredFingerprint(payload) } } };
    const native = { id: lineId, orderId, storeId: C, quantity: 2, unitPrice: 100, lineSubtotal: 200, lineDiscount: 33, lineTax: 33, lineTotal: 200, metadata: { vendure: { id: 7 } } };
    const context = { storeId: C, orderId, currency: 'USD', orderLines: [native], couponCodes: ['EXPIRED'] };
    const basis = readImportedOrderEditBasis(metadata, context);
    expect(basis.lines).toEqual([{ key: lineId, quantity: 2, placedQuantity: 3, unitListPrice: 120, priceIncludesTax: true, taxRateBps: 2000, priorAdjustments: [] }]);
    expect(() => readImportedOrderEditBasis(metadata, { ...context, orderId: B })).toThrow(/order identity/);
    expect(() => readImportedOrderEditBasis(metadata, { ...context, orderLines: [{ ...native, unitPrice: 101 }] })).toThrow();
    expect(() => readImportedOrderEditBasis(metadata, { ...context, couponCodes: ['OTHER'] })).toThrow();
    const changed = structuredClone(metadata); changed.vendure.editBasisV1.lines[0]!.sourceRecord += ' ';
    expect(() => readImportedOrderEditBasis(changed, context)).toThrow();
    expect(() => readImportedOrderEditBasis({ vendure: { id: 9, sourceKey: 'source' } }, context)).toThrow();
    // Header anomalies stay raw; equal rounded JS Numbers do not prove parity.
    const anomalous = { ...payload, sourceOrderRecord: payload.sourceOrderRecord.replace('"subTotal":167', '"subTotal":9007199254740993'),
      header: { ...payload.header, subTotal: '9007199254740993' } };
    const captured = { vendure: { id: 9, sourceKey: 'source', editBasisV1: { ...anomalous, sourceDigest: orderEditStoredFingerprint(anomalous) } } };
    expect(readImportedOrderEditBasis(captured, context).lines).toEqual(basis.lines);
    const roundedCollision = { ...anomalous, header: { ...anomalous.header, subTotal: '9007199254740992' } };
    expect(() => readImportedOrderEditBasis({ vendure: { id: 9, sourceKey: 'source', editBasisV1: {
      ...roundedCollision, sourceDigest: orderEditStoredFingerprint(roundedCollision) } } }, context)).toThrow(/header differs/);
  });

  it('retains independent mixed shipping getters & signed surcharge facts after merchandise changes', () => {
    const payload = { version: 1, format: 'retained-pg-jsonb-text-v1', sourceKey: 'source', sourceOrderId: '9',
      sourceOrderRecord: JSON.stringify({ id: 9, currencyCode: 'USD', subTotal: -100, subTotalWithTax: -120, shipping: 15, shippingWithTax: 18 }),
      channel: { sourceId: '3', projection: 'pricing-v1', sourceRecord: JSON.stringify({ id: 3, defaultCurrencyCode: 'USD', pricesIncludeTax: false, defaultTaxZoneId: 1 }), orderChannelRecord: JSON.stringify({ orderId: 9, channelId: 3 }) },
      header: { subTotal: '-100', subTotalWithTax: '-120', shipping: '15', shippingWithTax: '18' },
      lines: [{ sourceId: '7', orderLineId: A, sourceRecord: JSON.stringify({ id: 7, orderId: 9, shippingLineId: 11 }) }],
      shippingLines: [
        { sourceId: '11', sourceRecord: JSON.stringify({ id: 11, orderId: 9, shippingMethodId: 4, listPrice: 12, listPriceIncludesTax: true, adjustments: [{ amount: -6 }], taxLines: [{ taxRate: 20 }] }) },
        { sourceId: '12', sourceRecord: JSON.stringify({ id: 12, orderId: 9, shippingMethodId: null, listPrice: 10, listPriceIncludesTax: false, adjustments: [], taxLines: [{ taxRate: 20 }] }) },
      ], shippingMethods: [{ sourceId: '4', sourceRecord: JSON.stringify({ id: 4, code: 'POST' }) }],
      surcharges: [{ sourceId: '13', sourceRecord: JSON.stringify({ id: 13, orderId: 9, description: 'Historic credit', listPrice: -120, listPriceIncludesTax: true, taxLines: [{ taxRate: 20 }] }) }] };
    const metadata = { vendure: { id: 9, sourceKey: 'source', editBasisV1: { ...payload, sourceDigest: orderEditStoredFingerprint(payload) } } };
    const components = readImportedOrderEditComponents(metadata, 'USD');
    expect(components.pricesIncludeTax).toBe(false);
    expect(components.shippingLines.map(line => line.orderLineIds)).toEqual([[A], []]);
    expect(components.shippingLines.map(({ net, gross, tax, methodCode }) => ({ net, gross, tax, methodCode }))).toEqual([
      { net: 5, gross: 6, tax: 1, methodCode: 'POST' }, { net: 10, gross: 12, tax: 2, methodCode: null },
    ]);
    expect(components.surcharges[0]).toMatchObject({ net: -100, gross: -120, tax: -20 });
    const foreignChannel = { ...payload, channel: { ...payload.channel, orderChannelRecord: JSON.stringify({ orderId: 8, channelId: 3 }) } };
    expect(() => readImportedOrderEditComponents({ vendure: { ...metadata.vendure, editBasisV1: { ...foreignChannel, sourceDigest: orderEditStoredFingerprint(foreignChannel) } } }, 'USD')).toThrow(/channel/);
    const missingMethod = { ...payload, shippingMethods: [] };
    expect(() => readImportedOrderEditComponents({ vendure: { ...metadata.vendure, editBasisV1: { ...missingMethod, sourceDigest: orderEditStoredFingerprint(missingMethod) } } }, 'USD')).toThrow(/method closure/);
  });

});
