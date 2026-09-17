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
import { and, eq, isNull } from 'drizzle-orm';
import type Stripe from 'stripe';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { stripeConfigured, stripeCreds, stripeModeFromConfig, verifyStripeWebhook, verifyIntent, STRIPE_REFUND_ATTEMPT_KEY, type IntentLike, type StripeMode } from '../payments/stripe.js';
import { applyPaymentResult, amountDueForOrder } from '../payments/settle.js';
import { resolveStoreIdForStripeEvent, resolveStoreIdForSubscriptionEvent, reconcileStripeRefund, recordStripeDispute, type StripeEventObj } from '../payments/webhook-reconcile.js';
import {
  onCheckoutCompleted, onInvoicePaid, onInvoiceFailed, onSubscriptionUpdated, onSubscriptionDeleted,
  type CheckoutSessionLike, type InvoiceLike, type SubscriptionObjLike,
} from '../payments/subscriptions.js';

// Subscription / invoice events resolve the tenant from OUR subscription row
// (via the RLS-safe seam), not from Stripe metadata propagation. An
// unresolvable one must return 5xx so Stripe RETRIES (the retry resolves once
// checkout.session.completed lands). SR-02: the same now applies to one-time
// events (refund/dispute/payment_intent) — acking an unresolved event drops
// it forever, so every unresolved event returns 503 for provider retry.
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

  // Resolve the tenant: signed metadata.storeId is the fast-path; the DB
  // anchor goes through resolveStoreForGatewayEvent (the SECURITY DEFINER
  // seam — the only lookup that works under the RLS nonowner role before
  // app.current_store exists). Unresolvable → 503 so Stripe retries: an
  // unresolved event can NEVER be safely acked — it would be dropped forever
  // (a refund/dispute whose payment row simply hasn't landed yet is the
  // common transient case; ordering races self-heal on redelivery).
  //
  // STRICT resolution (0060): the seam fails closed on any multi-store ref
  // match, and we bind `mode: verifiedMode` — the webhook secret that
  // verified the signature is the event's cryptographically-proven mode, the
  // only pre-resolution fact worth trusting (Stripe payloads carry no usable
  // account ref). A test-signed event therefore can't resolve a live-mode
  // payment row's tenant at all; it 503s rather than reaching the in-tx
  // mode check below — the same outcome the ra-sec check enforces, earlier.
  const isSubEvent = SUBSCRIPTION_EVENT_TYPES.has(event.type);
  const binding = { mode: verifiedMode };
  const storeId = isSubEvent
    ? await resolveStoreIdForSubscriptionEvent(event.data.object as Parameters<typeof resolveStoreIdForSubscriptionEvent>[0], binding)
    : await resolveStoreIdForStripeEvent(event.data.object as StripeEventObj, binding);
  if (!storeId) return c.json({ error: 'tenant unresolved — retry' }, 503);

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
        //
        // MONEY-4: the order may have been auto-cancelled (stale-allocation TTL
        // job, purely on created_at age) by the time this event lands, even
        // though Stripe genuinely captured the money. Don't silently drop that —
        // still verify + record it (applyPaymentResult flags a non-payable state
        // with an audit_log entry instead of transitioning to Paid). Any OTHER
        // terminal state (Paid/Refunded/PartiallyRefunded) is left alone — those
        // are legitimate no-ops, not the money-goes-invisible bug.
        if (!order) return;
        if (order.state !== 'PendingPayment' && order.state !== 'Cancelled') return;
        // MONEY-3: verify against what's actually still owed (grandTotal minus
        // any Settled tenders already recorded, e.g. a partial gift-card
        // draw-down), not the raw order total.
        const amountDue = await amountDueForOrder(tx, storeId, order.id, order.grandTotal);
        if (amountDue <= 0) return; // already fully covered by other tenders — nothing to verify/record
        // SR-03: the verifying signature's mode IS the trusted original mode —
        // persist it on the payment row (via verifyIntent's metadata.gateway)
        // so a later refund never has to infer it from current store config.
        const result = verifyIntent(pi, { orderCode: code, amount: amountDue, currency: order.currency, stripeMode: verifiedMode });
        if (result.state === 'Settled') {
          await applyPaymentResult(tx, { storeId, order: { ...order, code }, method: 'stripe', result, amount: amountDue });
        }
        return;
      }
      // Dashboard/API refunds → converge on the durable refund attempt when one
      // exists (SR-04: stamped attempt id, else a unique unbound reservation),
      // else record a provider-initiated refund row. refund.* is the primary
      // path (Acacia 2024-10-28+ fires it for all refunds); charge.refunded is
      // kept for pre-Acacia / belt-and-suspenders — both dedup on re_id.
      case 'refund.created':
      case 'refund.updated': {
        const r = event.data.object as unknown as { id: string; amount: number; status: string; payment_intent?: string | { id?: string }; metadata?: Record<string, string> | null };
        const pi = typeof r.payment_intent === 'string' ? r.payment_intent : r.payment_intent?.id;
        if (pi && r.id) await reconcileStripeRefund(tx, storeId, {
          reId: r.id, amount: r.amount, status: r.status, piId: pi,
          attemptId: r.metadata?.[STRIPE_REFUND_ATTEMPT_KEY] ?? null,
        }, { mode: verifiedMode });
        return;
      }
      case 'charge.refunded': {
        const ch = event.data.object as unknown as { payment_intent?: string | { id?: string }; refunds?: { data?: Array<{ id: string; amount: number; status: string; payment_intent?: string | { id?: string }; metadata?: Record<string, string> | null }> } };
        const chPi = typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id;
        for (const r of ch.refunds?.data ?? []) {
          const pi = (typeof r.payment_intent === 'string' ? r.payment_intent : r.payment_intent?.id) ?? chPi;
          if (pi && r.id) await reconcileStripeRefund(tx, storeId, {
            reId: r.id, amount: r.amount, status: r.status, piId: pi,
            attemptId: r.metadata?.[STRIPE_REFUND_ATTEMPT_KEY] ?? null,
          }, { mode: verifiedMode });
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
      case 'invoice.paid': {
        const invoice = event.data.object as unknown as InvoiceLike;
        await onInvoicePaid(tx, storeId, invoice);
        // SR-03: subscription payments are minted inside subscriptions.ts
        // (settleFirstCycle + renewal insert) with no gateway metadata — the
        // verifying signature's mode is the only trusted source. Backfill it
        // on the ledger row this invoice settled; the (store, provider_ref)
        // stripe dedupe index makes a redelivery a no-op, and the IS NULL
        // guard never overwrites an already-persisted identity.
        const invoiceRef = (typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id) ?? invoice.id;
        if (invoiceRef) {
          await tx.update(s.payment).set({ gatewayMode: verifiedMode })
            .where(and(eq(s.payment.providerRef, invoiceRef), eq(s.payment.method, 'stripe'), isNull(s.payment.gatewayMode)));
        }
        return;
      }
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
