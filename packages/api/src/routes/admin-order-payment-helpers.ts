import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { getProvider } from '../payments/provider.js';

export async function alreadyRefunded(tx: Tx, orderId: string): Promise<number> {
  // Drizzle's typed query builder — no `as any`. `tx` is the withStore() txn
  // handle and exposes the same `select({...}).from(...).where(...)` shape.
  // Exclude Failed refunds — a failed gateway reversal returned no money, so it
  // must not count against the order's refundable balance (over-blocks otherwise).
  const [r] = await tx.select({ n: sql<number>`coalesce(sum(${s.refund.amount}),0)::int` }).from(s.refund).where(and(eq(s.refund.orderId, orderId), sql`${s.refund.state} <> 'Failed'`));
  return r?.n ?? 0;
}

/**
 * Calls the payment gateway to execute the monetary refund and returns the
 * provider-resolved state + ref. For manual/cod (no provider.refundPayment)
 * this is a no-op that returns { state: 'Settled', providerRef: null }.
 *
 * `idempotencyKey` MUST be deterministic per logical refund (same across a
 * retry, distinct across different refunds) — see callers in admin-orders.ts
 * for the derivation. Passed straight through to the provider; manual/cod
 * ignore it (no gateway call to dedupe).
 *
 * This function performs external I/O and therefore must never be called from
 * inside `withStore`. Callers prepare in one transaction, invoke this with no
 * transaction open, then finalize in a second transaction.
 */
export async function executeGatewayRefund(
  payMethod: string,
  payProviderRef: string | null,
  amount: number,
  currency: string,
  stripeMode: 'test' | 'live' | undefined,
  idempotencyKey: string,
): Promise<{ state: 'Settled' | 'Pending'; providerRef: string | null }> {
  const provider = getProvider(payMethod);
  if (!provider) {
    throw Object.assign(
      new Error(`refund not supported for payment method '${payMethod}'`),
      { kind: 'providerfail' as const, message: `refund not supported for payment method '${payMethod}'` },
    );
  }
  if (!provider.refundPayment) {
    return { state: 'Settled', providerRef: null };
  }
  const r = await provider.refundPayment({ providerRef: payProviderRef, amount, currency, stripeMode, idempotencyKey });
  if (r.state === 'Failed') {
    throw Object.assign(new Error(r.errorMessage ?? 'gateway refund failed'), { kind: 'providerfail' as const, message: r.errorMessage ?? 'gateway refund failed' });
  }
  return { state: r.state as 'Settled' | 'Pending', providerRef: r.providerRef };
}

export async function creditGiftCardRefund(tx: Tx, storeId: string, orderId: string, amount: number): Promise<void> {
  const [redemption] = await tx
    .select({ giftCardId: s.giftCardTransaction.giftCardId })
    .from(s.giftCardTransaction)
    .where(and(eq(s.giftCardTransaction.orderId, orderId), lt(s.giftCardTransaction.amount, 0)))
    .orderBy(desc(s.giftCardTransaction.createdAt))
    .limit(1);
  if (!redemption) {
    throw new Error(`gift_card refund on order ${orderId}: no gift-card redemption found to credit back`);
  }
  await tx.update(s.giftCard)
    .set({ balance: sql`${s.giftCard.balance} + ${amount}`, updatedAt: new Date() })
    .where(eq(s.giftCard.id, redemption.giftCardId));
  await tx.insert(s.giftCardTransaction).values({
    storeId, giftCardId: redemption.giftCardId, orderId, amount,
  });
}
