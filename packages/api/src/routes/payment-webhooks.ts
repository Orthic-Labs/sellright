/**
 * WP3: inbound Stripe webhooks. Raw-body HMAC signature verification, then
 * idempotent processing keyed on the Stripe event id (processed_event text PK).
 *
 * Mounted OUTSIDE the shop/admin CSRF guards — this path is neither /v1/shop nor
 * /v1/admin and carries no cookie session, so CSRF doesn't apply; Stripe's
 * signature IS the authentication. The raw body must be read BEFORE any JSON
 * parse for the signature to verify.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { stripeClient, stripeConfigured, verifyIntent, type IntentLike } from '../payments/stripe.js';
import { applyPaymentResult } from '../payments/settle.js';

export const paymentWebhooks = new OpenAPIHono();

paymentWebhooks.post('/v1/webhooks/stripe', async (c) => {
  if (!stripeConfigured() || !env.STRIPE_WEBHOOK_SECRET) return c.json({ error: 'stripe not configured' }, 503);
  const sig = c.req.header('stripe-signature');
  if (!sig) return c.json({ error: 'missing signature' }, 400);
  const raw = await c.req.text(); // raw body BEFORE json parse — Stripe sig requires it
  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(raw, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return c.json({ error: 'bad signature' }, 400);
  }

  const obj = event.data.object as { metadata?: { storeId?: string; orderCode?: string } };
  const storeId = obj.metadata?.storeId;
  // No tenant on the object (e.g. a Charge that didn't inherit PI metadata) →
  // ack so Stripe stops retrying; nothing for us to reconcile.
  if (!storeId) return c.json({ received: true }, 200);

  await withStore(storeId, async (tx) => {
    // Idempotency: claim the event id. A duplicate delivery is a no-op.
    const claimed = await tx
      .insert(s.processedEvent)
      .values({ id: event.id, storeId, type: event.type })
      .onConflictDoNothing()
      .returning({ id: s.processedEvent.id });
    if (claimed.length === 0) return;

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as unknown as IntentLike & { metadata?: { orderCode?: string } };
        const code = pi.metadata?.orderCode;
        if (!code) return;
        const [order] = await tx
          .select({ id: s.order.id, state: s.order.state, grandTotal: s.order.grandTotal, currency: s.order.currency })
          .from(s.order).where(eq(s.order.code, code)).limit(1);
        // Safety net for a client that died before calling /pay. If /pay already
        // settled it the order is Paid → skip (no duplicate payment row). Re-run
        // the same server-side verification before trusting the event.
        if (!order || order.state !== 'PendingPayment') return;
        const result = verifyIntent(pi, { orderCode: code, amount: order.grandTotal, currency: order.currency });
        if (result.state === 'Settled') {
          await applyPaymentResult(tx, { storeId, order, method: 'stripe', result });
        }
        return;
      }
      // TODO(reconcile): refund initiated from the Stripe dashboard. Matching it
      // idempotently against the admin-initiated refund ledger needs a product
      // decision to avoid double-counting; the event is claimed + ack'd here.
      case 'charge.refunded':
        return;
      // TODO(ops): dispute alerting (operator email/Telegram) wires with WP6d.
      case 'charge.dispute.created':
        return;
      default:
        return;
    }
  });
  return c.json({ received: true }, 200);
});
