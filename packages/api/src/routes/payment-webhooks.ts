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
import { stripeConfigured, stripeCreds, stripeModeFromConfig, verifyStripeWebhook, verifyIntent, type IntentLike, type StripeMode } from '../payments/stripe.js';
import { applyPaymentResult } from '../payments/settle.js';

export const paymentWebhooks = new OpenAPIHono();

paymentWebhooks.post('/v1/webhooks/stripe', async (c) => {
  if (!stripeConfigured('test') && !stripeConfigured('live')) return c.json({ error: 'stripe not configured' }, 503);
  const sig = c.req.header('stripe-signature');
  if (!sig) return c.json({ error: 'missing signature' }, 400);
  const raw = await c.req.text(); // raw body BEFORE json parse — Stripe sig requires it
  let event: Stripe.Event | null = null;
  let verifiedMode: StripeMode | null = null;
  for (const mode of ['test', 'live'] as StripeMode[]) {
    const secret = stripeCreds(mode).webhookSecret;
    if (!secret) continue;
    try {
      // Verify with the webhook secret ONLY — must not require that mode's API
      // secret key to be present (constructEvent is pure crypto), or a store with
      // a webhook secret but a cleared/rotated API key can't process webhooks.
      event = verifyStripeWebhook(raw, sig, secret);
      verifiedMode = mode;
      break;
    } catch {
      // signature didn't match this mode's secret — try the other.
    }
  }
  if (!event || !verifiedMode) return c.json({ error: 'bad signature' }, 400);

  const obj = event.data.object as { metadata?: { storeId?: string; orderCode?: string } };
  const storeId = obj.metadata?.storeId;
  // No tenant on the object (e.g. a Charge that didn't inherit PI metadata), or a
  // malformed id → ack so Stripe stops retrying. A non-UUID would also fail the
  // ::uuid cast in the RLS policy and 500 → Stripe retry storm; reject it here.
  if (!storeId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storeId)) return c.json({ received: true }, 200);

  await withStore(storeId, async (tx) => {
    // ra-sec: bind the verifying secret's mode to the store's configured mode. A
    // webhook signed with the TEST secret must not drive payment_intent.succeeded
    // on a LIVE store (a leaked test webhook secret would otherwise let a forged
    // event settle a live order). Mismatch → ack + ignore.
    const [store] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
    if (!store || stripeModeFromConfig(store.config) !== verifiedMode) return;
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
          .select({ id: s.order.id, state: s.order.state, grandTotal: s.order.grandTotal, currency: s.order.currency, customerId: s.order.customerId })
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
      // Refunds initiated from the Stripe dashboard are claimed and ack'd here.
      // Matching them idempotently against the admin refund ledger needs a
      // product decision to avoid double-counting.
      case 'charge.refunded':
        return;
      // Dispute alerting can wire operator notifications here.
      case 'charge.dispute.created':
        return;
      default:
        return;
    }
  });
  return c.json({ received: true }, 200);
});
