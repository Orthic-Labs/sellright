import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { emitEvent } from '../webhooks/emit.js';
import { pickEmailAppKey } from '../email/dispatch.js';
import { orderConfirmation } from '../email/templates.js';
import { enqueueEmail } from '../email/outbox.js';
import { normalizeEmail } from '../auth/email.js';
import { env } from '../env.js';

function appValue(raw: string | undefined, appKey: string | null | undefined) {
  const key = appKey?.trim().toLowerCase();
  if (!key || !raw) return undefined;
  for (const entry of raw.split(/[,\n;]/)) {
    const i = entry.indexOf('=');
    if (i > 0 && entry.slice(0, i).trim().toLowerCase() === key) return entry.slice(i + 1).trim();
  }
  return undefined;
}

/** Called only by the transaction that wins the PendingPayment -> Paid transition. */
export async function enqueuePaidEffects(tx: Tx, storeId: string, orderId: string) {
  const [order] = await tx.select().from(s.order).where(eq(s.order.id, orderId)).limit(1);
  const [store] = await tx.select().from(s.store).where(eq(s.store.id, storeId)).limit(1);
  if (!order || !store) throw new Error('Paid order context is missing');
  await emitEvent(tx, storeId, 'order.paid', {
    code: order.code, grandTotal: order.grandTotal, currency: order.currency,
  });
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
  const from = appValue(env.EMAIL_FROM_BY_APP, appKey) ?? env.SMTP_FROM;
  const storefrontUrl = appValue(env.STOREFRONT_URL_BY_APP, appKey) ?? env.STOREFRONT_URL;
  const rendered = orderConfirmation({ name: store.name, currency: order.currency, storefrontUrl, fromEmail: from },
    { code: order.code, grandTotal: order.grandTotal, currency: order.currency,
      lines: lines.map(({ name, quantity, lineTotal }) => ({ name, quantity, lineTotal })) });
  await enqueueEmail(tx, storeId, { kind: 'order_confirmation', recipient,
    payload: { to: recipient, from, subject: rendered.subject, html: rendered.html, text: rendered.text } });
}
