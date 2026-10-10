import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { emitEvent } from '../webhooks/emit.js';
import { pickEmailAppKey, enqueueOrderConfirmation } from '../email/dispatch.js';
import { normalizeEmail } from '../auth/email.js';
import { enrollOnPaidOrder } from '../jobs/listmonk-sync.js';
import { bootstrapAccountAndQueueAccessMail } from '../licensing/account-bootstrap.js';
import { postPaidOrderRewards } from '../loyalty/bonus.js';

/** The `order.paid` webhook event. */
export async function emitOrderPaidEvent(
  tx: Tx, storeId: string, order: { code: string; grandTotal: number; currency: string },
): Promise<void> {
  await emitEvent(tx, storeId, 'order.paid', {
    code: order.code, grandTotal: order.grandTotal, currency: order.currency,
  });
}

/**
 * Confirmation email + list enrolment for a paid order (the async paid paths).
 * No-ops when the order has no resolvable recipient. Used by the `notification`
 * effect handler (effect-handlers.ts) and by enqueuePaidEffects below.
 */
export async function sendOrderConfirmationAndEnrol(tx: Tx, storeId: string, orderId: string): Promise<void> {
  const [order] = await tx.select().from(s.order).where(eq(s.order.id, orderId)).limit(1);
  const [store] = await tx.select().from(s.store).where(eq(s.store.id, storeId)).limit(1);
  if (!order || !store) throw new Error('Paid order context is missing');
  const [customer] = order.customerId
    ? await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, order.customerId)).limit(1) : [];
  const contact = (order.metadata as { contact?: { email?: string } } | null)?.contact;
  const recipient = normalizeEmail(contact?.email || customer?.email || '');
  if (!recipient) return;
  const lines = await tx.select({
    name: s.orderLine.variantName, quantity: s.orderLine.quantity,
    lineTotal: s.orderLine.lineTotal, appKey: s.productVariant.appKey,
  }).from(s.orderLine).leftJoin(s.productVariant, eq(s.productVariant.id, s.orderLine.variantId))
    .where(eq(s.orderLine.orderId, order.id));
  const appKey = pickEmailAppKey(lines.map(line => line.appKey));
  // SR-05: the store's own canonical storefront URL + sender (store.config)
  // resolve inside enqueueOrderConfirmation; a per-app env override still wins
  // for shared stores whose order lines all carry one appKey.
  // dedupeKey makes the enqueue idempotent — a settlement path that runs twice
  // (e.g. webhook racing the return-path settle) cannot double-send.
  await enqueueOrderConfirmation(tx, storeId,
    { name: store.name, currency: order.currency, appKey, config: store.config },
    recipient,
    { code: order.code, grandTotal: order.grandTotal, currency: order.currency,
      lines: lines.map(({ name, quantity, lineTotal }) => ({ name, quantity, lineTotal })),
      dedupeKey: `order_confirmation:${order.id}` });

  // Listmonk parity: a paid order enrolls the customer as a confirmed 'order'
  // subscriber (dedupe on store+email+kind+topic; never throws — a bad address
  // is logged and skipped inside enrollOnPaidOrder).
  await enrollOnPaidOrder(tx, storeId, { orderId: order.id, orderCode: order.code, email: recipient });
}

/**
 * Direct (synchronous) composition of the async-path paid effects for an
 * already-Paid order. Production settlement no longer calls this: the same
 * steps run as `account_bootstrap` / `loyalty_earn` / `notification` effects
 * behind recordSettlementOperation() (effect-handlers.ts). Kept as a single
 * entry for replay tooling and the SR-05 / account-bootstrap regression suites.
 */
export async function enqueuePaidEffects(tx: Tx, storeId: string, orderId: string) {
  const [order] = await tx.select().from(s.order).where(eq(s.order.id, orderId)).limit(1);
  const [store] = await tx.select().from(s.store).where(eq(s.store.id, storeId)).limit(1);
  if (!order || !store) throw new Error('Paid order context is missing');
  await emitOrderPaidEvent(tx, storeId, order);
  // Purchase → account bootstrap: a software-account-flagged purchase attaches
  // or creates a passwordless customer account and queues the one-time claim
  // mail through the same durable outbox (dedupeKey'd per order). Idempotent —
  // no-op once the order carries a customerId.
  await bootstrapAccountAndQueueAccessMail(tx, {
    storeId, orderId: order.id, existingCustomerId: order.customerId,
  });
  // LOYALTY-1: post the points this order earns (snapshot taken at checkout;
  // registered customers only). Runs after the account bootstrap so a
  // freshly attached account is credited; idempotent per order.
  // REWARDS-1: also posts the first-order bonus and queues the points_earned email.
  await postPaidOrderRewards(tx, { storeId, orderId: order.id, paidAt: order.placedAt ?? new Date(), store });
  await sendOrderConfirmationAndEnrol(tx, storeId, order.id);
}
