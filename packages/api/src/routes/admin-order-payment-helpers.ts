import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { getProvider } from '../payments/provider.js';
import { stripeModeFromConfig } from '../payments/stripe.js';

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
 * Throws { kind: 'providerfail', message } on gateway failure so the caller
 * can exit the withStore() txn cleanly without writing any ledger rows.
 */
export async function executeGatewayRefund(
  tx: Tx,
  storeId: string,
  payMethod: string,
  payProviderRef: string | null,
  amount: number,
  currency: string,
): Promise<{ state: 'Settled' | 'Pending'; providerRef: string | null }> {
  const provider = getProvider(payMethod);
  if (!provider?.refundPayment) {
    return { state: 'Settled', providerRef: null };
  }
  let stripeMode: 'test' | 'live' | undefined;
  if (payMethod === 'stripe') {
    const [row] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
    stripeMode = stripeModeFromConfig(row?.config);
  }
  const r = await provider.refundPayment({ providerRef: payProviderRef, amount, currency, stripeMode });
  if (r.state === 'Failed') {
    throw Object.assign(new Error(r.errorMessage ?? 'gateway refund failed'), { kind: 'providerfail' as const, message: r.errorMessage ?? 'gateway refund failed' });
  }
  return { state: r.state as 'Settled' | 'Pending', providerRef: r.providerRef };
}
