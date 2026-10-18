import { buildImportedEditBasis } from './history.js';

/** Synthetic imported history for economic-admission DB regressions. */
export function retainedDetachedHistoryFixture(input: {
  storeId: string; orderId: string; orderLineId: string; metadata: unknown;
}) {
  if (input.metadata !== null && (typeof input.metadata !== 'object' || Array.isArray(input.metadata))) {
    throw new Error('Fixture base metadata must be an object or null');
  }
  const { storeId, orderId, orderLineId } = input, sourceKey = 'synthetic-detached-history';
  const capture = buildImportedEditBasis({ storeId, sourceKey, channelId: '1', currency: 'USD',
    id: entity => entity === 'order' ? orderId : orderLineId,
    targetOrders: [{ id: orderId, storeId, metadata: { vendure: { id: '1', sourceKey } } }],
    targetLines: [{ id: orderLineId, orderId, storeId, metadata: { vendure: { id: '1' } } }],
    orders: [{ id: '1', selected: true, sourceRecord: '{"id":1,"state":"PaymentSettled","currencyCode":"USD","couponCodes":[]}',
      subTotal: '2000', subTotalWithTax: '2000', shipping: '500', shippingWithTax: '500' }],
    lines: [{ id: '1', orderId: '1', shippingLineId: '7',
      sourceRecord: '{"id":1,"orderId":1,"shippingLineId":7,"quantity":2,"orderPlacedQuantity":2,"listPrice":1000,"listPriceIncludesTax":false,"adjustments":[],"taxLines":[]}' }],
    shippingLines: [{ id: '7', orderId: null, shippingMethodId: '5',
      sourceRecord: '{"id":7,"orderId":null,"shippingMethodId":5,"listPrice":500,"listPriceIncludesTax":false,"adjustments":[],"taxLines":[]}' }],
    shippingMethods: [{ id: '5', sourceRecord: '{"id":5,"code":"historical"}' }], surcharges: [],
    channels: [{ id: '1', sourceRecord: '{"id":1,"defaultCurrencyCode":"USD","pricesIncludeTax":false,"defaultTaxZoneId":null}' }],
    orderChannels: [{ orderId: '1', channelId: '1', sourceRecord: '{"orderId":1,"channelId":1}' }],
  })[0]!;
  if (Object.hasOwn(capture, 'editBasisV1') || !('retainedHistoryV1' in capture) || !capture.retainedHistoryV1) {
    throw new Error('Detached history fixture must not provide an operational edit basis');
  }
  return { ...input.metadata,
    vendure: { id: '1', sourceKey, state: 'PaymentSettled', retainedHistoryV1: capture.retainedHistoryV1 } };
}
