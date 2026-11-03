/**
 * Review-request email (#315): once an order is delivered, ask the customer to review what they received.
 * Called inside the transaction that marks the order Delivered (jobs/auto-deliver.ts), so the email commits or rolls
 * back with the transition and the outbox dedupe key (one per order) keeps a replayed pass from mailing twice.
 */
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { enqueueReviewRequest } from '../email/dispatch.js';
import { resolveOrderRecipient } from '../orders/recipient.js';
import { loadOrderLines } from '../routes/order-facts.js';
import { reviewSettingsFromConfig } from './reviews.js';

/** Enqueue one review-request email per order that has a recipient and at least one reviewable product. Returns how many were queued. */
export async function enqueueReviewRequests(tx: Tx, storeId: string, orderIds: string[]): Promise<number> {
  if (!orderIds.length) return 0;
  const [store] = await tx.select({ name: s.store.name, currency: s.store.currency, config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
  if (!store || !reviewSettingsFromConfig(store.config).enabled) return 0;
  let queued = 0;
  for (const orderId of orderIds) {
    const [order] = await tx.select({ id: s.order.id, code: s.order.code, customerId: s.order.customerId, metadata: s.order.metadata })
      .from(s.order).where(and(eq(s.order.id, orderId), eq(s.order.storeId, storeId))).limit(1);
    if (!order) continue;
    const recipient = await resolveOrderRecipient(tx, order);
    if (!recipient) continue;
    const items = new Map<string, { name: string; slug: string }>();
    for (const l of await loadOrderLines(tx, order.id)) {
      if (l.productSlug && !items.has(l.productSlug)) items.set(l.productSlug, { name: l.productName ?? l.name, slug: l.productSlug });
    }
    if (!items.size) continue;
    if (await enqueueReviewRequest(tx, storeId, store, recipient, { code: order.code, items: [...items.values()], dedupeKey: `review_request:${order.id}` })) queued++;
  }
  return queued;
}
