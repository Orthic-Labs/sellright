import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';

/** Caller holds the order row lock, shared with creation and reconciliation. */
export async function hasUnresolvedPayment(tx: Tx, orderId: string): Promise<boolean> {
  const [attempt] = await tx.select({ id: s.paymentAttempt.id }).from(s.paymentAttempt).where(and(
    eq(s.paymentAttempt.orderId, orderId), inArray(s.paymentAttempt.status, ['processing', 'pending', 'unknown']),
  )).limit(1);
  if (attempt) return true;
  const [payment] = await tx.select({ id: s.payment.id }).from(s.payment).where(and(
    eq(s.payment.orderId, orderId), inArray(s.payment.state, ['Pending', 'Authorized']),
  )).limit(1);
  return !!payment;
}
