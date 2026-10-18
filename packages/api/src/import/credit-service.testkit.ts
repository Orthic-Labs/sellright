import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { migrationId } from './context.js';
import { orderEditStoredFingerprint } from '../orders/order-edit-stack.js';
export async function retainedOrder(STORE: string) {
  return withStore(STORE, async tx => {
    const sourceKey = 'retained-synthetic', mapped = (kind: string, source: number) => migrationId(STORE, sourceKey, kind, source);
    const orderId = mapped('order', 9), lineId = mapped('order-line', 7), creditId = mapped('account-credit', 4), promoId = mapped('promotion', 5);
    const rawLine = { id: 7, orderId: 9, quantity: 2, orderPlacedQuantity: 3, listPrice: 100, listPriceIncludesTax: true,
      adjustments: [{ amount: -101, type: 'PROMOTION', adjustmentSource: 'PROMOTION:5' }], taxLines: [], shippingLineId: null };
    const basis = { version: 1, format: 'retained-pg-jsonb-text-v1', sourceKey, sourceOrderId: '9',
      sourceOrderRecord: JSON.stringify({ id: 9, currencyCode: 'USD', subTotal: 133, subTotalWithTax: 133, shipping: 0, shippingWithTax: 0, couponCodes: ['IMPORTED'] }),
      channel: { sourceId: '1', projection: 'pricing-v1', sourceRecord: JSON.stringify({ id: 1, defaultCurrencyCode: 'USD', pricesIncludeTax: true, defaultTaxZoneId: null }),
        orderChannelRecord: JSON.stringify({ orderId: 9, channelId: 1 }) }, shippingMethods: [],
      header: { subTotal: '133', subTotalWithTax: '133', shipping: '0', shippingWithTax: '0' },
      lines: [{ sourceId: '7', orderLineId: lineId, sourceRecord: JSON.stringify(rawLine) }], shippingLines: [], surcharges: [] };
    const sourceRecord = JSON.stringify({ id: 4, promotionId: 5, currencyCode: 'USD' });
    const sourcePromotionRecord = JSON.stringify({ id: 5, actions: [{ code: 'account_credit_discount' }], conditions: [{ code: 'account_credit_eligible' }] });
    await tx.insert(s.promotion).values({ id: promoId, storeId: STORE, code: 'IMPORTED', type: 'account_credit', value: 0 });
    await tx.insert(s.accountCredit).values({ id: creditId, storeId: STORE, promotionId: promoId, currency: 'USD', emailNormalized: 'retained@example.invalid',
      issuanceKey: 'retained', initialAmount: 1000, balance: 899, sourceKey, sourceId: '4', sourceRecord, sourcePromotionRecord,
      sourceDigest: orderEditStoredFingerprint({ format: 'retained-pg-jsonb-text-v1', account: sourceRecord, promotion: sourcePromotionRecord }) });
    await tx.insert(s.order).values({ id: orderId, storeId: STORE, code: 'RETAINED', state: 'Paid', currency: 'USD', promotionId: promoId,
      subtotal: 200, discountTotal: 67, grandTotal: 133, couponCodes: ['IMPORTED'], metadata: { vendure: { id: 9, sourceKey,
        editBasisV1: { ...basis, sourceDigest: orderEditStoredFingerprint(basis) } } } });
    await tx.insert(s.orderLine).values({ id: lineId, storeId: STORE, orderId, variantSku: 'RETAINED', variantName: 'Retained', quantity: 2,
      unitPrice: 100, lineSubtotal: 200, lineDiscount: 67, lineTotal: 133, metadata: { vendure: { id: 7 } } });
    const transactionRecord = JSON.stringify({ id: 6, accountCreditId: 4, orderId: 9, kind: 'REDEEM', status: 'POSTED', amount: 101, delta: -101, allocation: { '7': [34, 34, 33] } });
    await tx.insert(s.accountCreditTransaction).values({ id: mapped('account-credit-transaction', 6), storeId: STORE, accountCreditId: creditId, orderId,
      kind: 'REDEEM', status: 'POSTED', amount: 101, delta: -101, balanceAfter: 899, idempotencyKey: 'retained-redeem',
      operationalAllocation: { [lineId]: [34, 34, 33] }, allocation: JSON.stringify({ '7': [34, 34, 33] }),
      sourceKey, sourceId: '6', sourceOrderId: '9', sourceRecord: transactionRecord,
      sourceDigest: orderEditStoredFingerprint({ format: 'retained-pg-jsonb-text-v1', transaction: transactionRecord }) });
    return { orderId, lineId, creditId };
  });
}
