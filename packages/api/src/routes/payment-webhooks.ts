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
import { resolveStoreIdForStripeEvent, resolveStoreIdForSubscriptionEvent, reconcileStripeRefund, recordStripeDispute, type StripeEventObj } from '../payments/webhook-reconcile.js';
import {
  onCheckoutCompleted, onInvoicePaid, onInvoiceFailed, onSubscriptionUpdated, onSubscriptionDeleted,
  type CheckoutSessionLike, type InvoiceLike, type SubscriptionObjLike,
} from '../payments/subscriptions.js';

// Subscription / invoice events resolve the tenant from OUR subscription row
// (DB-primary), not from Stripe metadata propagation. An unresolvable one must
// return 5xx so Stripe RETRIES (the retry resolves once checkout.session.completed
// lands). Everything else resolves via resolveStoreIdForStripeEvent and acks.
const SUBSCRIPTION_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

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

  // Resolve the tenant: PaymentIntent-derived events carry storeId in metadata
  // (Stripe copies PI metadata onto the Charge at confirmation); refund/dispute
  // events fall back to a payment_intent → payment-ledger lookup. Unresolvable
  // (or a malformed id that'd blow the ::uuid RLS cast) → ack so Stripe stops
  // retrying. resolveStoreIdForStripeEvent only returns validated UUIDs.
  const isSubEvent = SUBSCRIPTION_EVENT_TYPES.has(event.type);
  const storeId = isSubEvent
    ? await resolveStoreIdForSubscriptionEvent(event.data.object as Parameters<typeof resolveStoreIdForSubscriptionEvent>[0])
    : await resolveStoreIdForStripeEvent(event.data.object as StripeEventObj);
  // Subscription/invoice events: unresolvable → 5xx so Stripe RETRIES (the row
  // appears once checkout.session.completed lands; idempotency makes retry safe).
  // One-time events: unresolvable → ack so Stripe stops retrying.
  if (!storeId) return isSubEvent ? c.json({ error: 'tenant unresolved — retry' }, 503) : c.json({ received: true }, 200);

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
      // Dashboard/API refunds → record in our ledger idempotently (dedup by the
      // Stripe refund id) and recompute order refund state. refund.* is the
      // primary path (Acacia 2024-10-28+ fires it for all refunds); charge.refunded
      // is kept for pre-Acacia / belt-and-suspenders — both dedup on re_id.
      case 'refund.created':
      case 'refund.updated': {
        const r = event.data.object as unknown as { id: string; amount: number; status: string; payment_intent?: string | { id?: string } };
        const pi = typeof r.payment_intent === 'string' ? r.payment_intent : r.payment_intent?.id;
        if (pi && r.id) await reconcileStripeRefund(tx, storeId, { reId: r.id, amount: r.amount, status: r.status, piId: pi });
        return;
      }
      case 'charge.refunded': {
        const ch = event.data.object as unknown as { payment_intent?: string | { id?: string }; refunds?: { data?: Array<{ id: string; amount: number; status: string; payment_intent?: string | { id?: string } }> } };
        const chPi = typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id;
        for (const r of ch.refunds?.data ?? []) {
          const pi = (typeof r.payment_intent === 'string' ? r.payment_intent : r.payment_intent?.id) ?? chPi;
          if (pi && r.id) await reconcileStripeRefund(tx, storeId, { reId: r.id, amount: r.amount, status: r.status, piId: pi });
        }
        return;
      }
      // Chargeback opened → record for operator visibility (no auto-refund/cancel).
      case 'charge.dispute.created': {
        const d = event.data.object as unknown as { id: string; amount: number; reason: string; status: string; payment_intent?: string | { id?: string } };
        const pi = typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id ?? null;
        await recordStripeDispute(tx, storeId, { disputeId: d.id, amount: d.amount, reason: d.reason, status: d.status, piId: pi });
        return;
      }
      // ── Subscriptions (Stripe Billing) ────────────────────────────────────
      case 'checkout.session.completed':
        await onCheckoutCompleted(tx, storeId, event.data.object as unknown as CheckoutSessionLike);
        return;
      case 'invoice.paid':
        await onInvoicePaid(tx, storeId, event.data.object as unknown as InvoiceLike);
        return;
      case 'invoice.payment_failed':
        await onInvoiceFailed(tx, storeId, event.data.object as unknown as InvoiceLike);
        return;
      case 'customer.subscription.updated':
        await onSubscriptionUpdated(tx, storeId, event.data.object as unknown as SubscriptionObjLike);
        return;
      case 'customer.subscription.deleted':
        await onSubscriptionDeleted(tx, storeId, event.data.object as unknown as SubscriptionObjLike);
        return;
      default:
        return;
    }
  });
  return c.json({ received: true }, 200);
});
