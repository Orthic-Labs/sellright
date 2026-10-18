import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { issue } from '../account-credit/service.js';
export async function seedImportedRefund(STORE: string, options: { cashUnit?: number; allocation?: number[]; state?: 'Paid' | 'Refunded'; method?: string; paymentAmount?: number; redemption?: boolean } = {}) {
  const cashUnit = options.cashUnit ?? 0, allocation = options.allocation ?? [0, 100];
  return withStore(STORE, async tx => {
    await tx.insert(s.store).values({ id: STORE, slug: 'refund-credit-synthetic', name: 'Synthetic', currency: 'USD' });
    const issued = await issue(tx, { storeId: STORE, amount: 1000, email: 'synthetic@example.invalid', issuanceKey: 'refund-fixture' });
    const [order] = await tx.insert(s.order).values({ storeId: STORE, code: randomUUID(), state: options.state ?? 'Paid', currency: 'USD',
      subtotal: cashUnit * 2 + 100, discountTotal: 100, shippingTotal: 50, grandTotal: cashUnit * 2 + 50,
      metadata: { contact: { email: 'buyer@example.invalid' } } }).returning();
    const [product] = await tx.insert(s.product).values({ storeId: STORE, slug: 'synthetic', name: 'Synthetic', status: 'active' }).returning();
    const [variant] = await tx.insert(s.productVariant).values({ storeId: STORE, productId: product!.id, sku: 'SYNTHETIC', name: 'Synthetic', price: 100, fulfillmentType: 'physical' }).returning();
    await tx.insert(s.stock).values({ storeId: STORE, variantId: variant!.id, onHand: 10, allocated: 0 });
    const [line] = await tx.insert(s.orderLine).values({ storeId: STORE, orderId: order!.id, variantId: variant!.id, variantSku: 'SYNTHETIC', variantName: 'Synthetic',
      quantity: 2, fulfilledQty: 2, unitPrice: cashUnit + 50, lineSubtotal: (cashUnit + 50) * 2, lineDiscount: 100, lineTotal: cashUnit * 2,
      metadata: { vendure: { quantity: 2, placedQuantity: 2, listPrice: cashUnit + 50, listPriceIncludesTax: true,
        adjustments: [{ amount: -100, type: 'PROMOTION' }], taxLines: [] } } }).returning();
    const [payment] = await tx.insert(s.payment).values({ storeId: STORE, orderId: order!.id, amount: options.paymentAmount ?? cashUnit * 2 + 50,
      method: options.method ?? 'nmi', state: 'Settled', currency: 'USD' }).returning();
    const redeemed = allocation.reduce((n, v) => n + v, 0);
    const redemptionId = randomUUID();
    if (options.redemption !== false) {
      await tx.update(s.accountCredit).set({ balance: 1000 - redeemed }).where(eq(s.accountCredit.id, issued.account.id));
      await tx.insert(s.accountCreditTransaction).values({ id: redemptionId, storeId: STORE, accountCreditId: issued.account.id,
        kind: 'REDEEM', status: 'POSTED', orderId: order!.id, orderCode: order!.code, amount: redeemed, delta: -redeemed,
        balanceAfter: 1000 - redeemed, idempotencyKey: 'fixture-redeem', operationalAllocation: { [line!.id]: allocation } });
    }
    if (options.state === 'Refunded') await tx.insert(s.refund).values({ storeId: STORE, orderId: order!.id, paymentId: payment!.id,
      amount: payment!.amount, itemsAmount: 0, shippingAmount: payment!.amount, state: 'Settled', metadata: { effectsApplied: true } });
    return { order: order!, line: line!, payment: payment!, accountId: issued.account.id, redemptionId, variantId: variant!.id };
  });
}
