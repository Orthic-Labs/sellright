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
import { withAdvisoryLock, withStore, type Tx } from '../db/client.js';
import { orderIdByCode, withLockedSet, type LockSubject } from '../db/locks.js';
import * as s from '../db/schema.js';
import { stripeCreds, stripeModeFromConfig, verifyStripeWebhook, listAllStoreIds, STRIPE_REFUND_ATTEMPT_KEY, type StripeMode } from '../payments/stripe.js';
import { applyStripeIntent, type StripeIntent } from '../payments/stripe-reconcile.js';
import { recordPaymentAlert } from '../payments/payment-alerts.js';
import { resolveField } from '../security/settings-resolver.js';
import { resolveStoreIdForStripeEvent, resolveStoreIdForSubscriptionEvent, reconcileStripeRefund, recordStripeDispute, orderIdsForStripePayments, type StripeEventObj } from '../payments/webhook-reconcile.js';
import { onStockChanged } from '../manifest/stock-hook.js';
import { recordSettlementOperation } from '../payments/settlement/record.js';
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

const piRef = (v: unknown): string | null => (typeof v === 'string' ? v : (v as { id?: string } | null)?.id ?? null);

/** Order(s) a money-recording event settles, refunds or disputes (X-45 / X-48). Planning reads
 *  only: nothing here locks. An event with no stored order yields [] and keeps the existing path. */
async function moneyOrderIds(storeId: string, event: Stripe.Event): Promise<string[]> {
  const obj = event.data.object as unknown as Record<string, unknown>;
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const code = (obj as { metadata?: { orderCode?: string } }).metadata?.orderCode;
      const id = code ? await orderIdByCode(storeId, code) : null;
      return id ? [id] : [];
    }
    case 'refund.created':
    case 'refund.updated':
      return orderIdsForStripePayments(storeId, [piRef(obj.payment_intent)]);
    case 'charge.refunded': {
      const chPi = piRef(obj.payment_intent);
      const refunds = ((obj.refunds as { data?: Array<{ payment_intent?: unknown }> } | undefined)?.data ?? []);
      return orderIdsForStripePayments(storeId, refunds.map((r) => piRef(r.payment_intent) ?? chPi));
    }
    case 'charge.dispute.created':
      return orderIdsForStripePayments(storeId, [piRef(obj.payment_intent)]);
    case 'invoice.paid': {
      // A subscription invoice settles the subscription's backing order (first cycle: Paid transition and
      // licence issue; renewal: its payment row). The subscription row is read unlocked for planning; when
      // none exists yet, the order named by the subscription metadata is planned (onInvoicePaid creates the
      // row against that order). An orderless subscription or invoice returns [] and keeps the plain path.
      const subRef = piRef(obj.subscription);
      if (subRef) {
        const [sub] = await withStore(storeId, (tx) => tx.select({ orderId: s.subscription.orderId }).from(s.subscription)
          .where(and(eq(s.subscription.storeId, storeId), eq(s.subscription.stripeSubscriptionId, subRef))).limit(1));
        if (sub) return sub.orderId ? [sub.orderId] : [];
      }
      const code = (obj.subscription_details as { metadata?: { orderCode?: string } } | undefined)?.metadata?.orderCode;
      const id = code ? await orderIdByCode(storeId, code) : null;
      return id ? [id] : [];
    }
    default:
      return [];
  }
}

/**
 * Lock subjects for a money-moving event (X-45 / PAYMENT-TIMING §3.5): the orders it settles, plus the licence a
 * subscription renewal extends (L2 is planned here so it is taken before any L3 order row, never after).
 */
async function moneyLockSubjects(storeId: string, event: Stripe.Event): Promise<LockSubject[]> {
  const subjects: LockSubject[] = (await moneyOrderIds(storeId, event)).map((orderId): LockSubject => ({ kind: 'order', orderId }));
  if (event.type === 'invoice.paid') {
    const subRef = piRef((event.data.object as unknown as Record<string, unknown>).subscription);
    if (subRef) {
      const [sub] = await withStore(storeId, (tx) => tx.select({ licenseId: s.subscription.licenseId }).from(s.subscription)
        .where(and(eq(s.subscription.storeId, storeId), eq(s.subscription.stripeSubscriptionId, subRef))).limit(1));
      if (sub?.licenseId) subjects.push({ kind: 'checkout', sourceLicenseId: sub.licenseId });
    }
  }
  return subjects;
}

export const paymentWebhooks = new OpenAPIHono();

paymentWebhooks.post('/v1/webhooks/stripe', async (c) => {
  const sig = c.req.header('stripe-signature');
  if (!sig) return c.json({ error: 'missing signature' }, 400);
  const raw = await c.req.text(); // raw body BEFORE json parse — Stripe sig requires it
  let event: Stripe.Event | null = null;
  let verifiedMode: StripeMode | null = null;
  // SECURITY (post-review fix): set ONLY when a DB-stored (per-store) secret
  // verified the signature — never for the env fast path, which is a single
  // shared secret with no per-store identity to bind. When set, the event's
  // resolved tenant MUST equal this store: the credential holder can sign an
  // arbitrary body (including a forged metadata.storeId, or a payment/
  // subscription ref that happens to belong to another store) — without this
  // check, a store with its OWN legitimately-configured webhook secret could
  // forge an event that settles/refunds a DIFFERENT store's order.
  let verifiedStoreId: string | null = null;
  // Fast path: env-configured (global, cross-store) webhook secrets — unchanged
  // from before WS-A, so an existing deployment behaves identically.
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
  // WS-A fallback: no env secret matched (or none configured) — try every
  // store's own DB-stored webhook secret. `store` carries no RLS (registry
  // table), so listing ids isn't an RLS bypass; each secret read still goes
  // through withStore + resolveField, scoped to that one store. Bounded by
  // the (typically single-digit) number of stores on this install.
  if (!event) {
    const storeIds = await listAllStoreIds();
    outer: for (const sid of storeIds) {
      for (const mode of ['test', 'live'] as StripeMode[]) {
        let secret: string | undefined;
        try {
          secret = await withStore(sid, async (tx) => {
            const r = await resolveField(tx, { storeId: sid, provider: 'stripe', mode, field: 'webhookSecret' }, undefined);
            return r.value || undefined;
          });
        } catch { continue; }
        if (!secret) continue;
        try {
          event = verifyStripeWebhook(raw, sig, secret);
          verifiedMode = mode;
          verifiedStoreId = sid;
          break outer;
        } catch { /* try the next candidate */ }
      }
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

  // SECURITY: a DB-stored secret cryptographically proves only "signed by
  // store X's credential" — never "about store X". A body forging
  // metadata.storeId (or a payment/subscription ref) to point at a DIFFERENT
  // store must not be processed against that other store. Ack-and-ignore
  // (never 503 — retrying can't fix a forged tenant claim) and audit it under
  // the store whose credential was used, so its owner can see the attempt.
  if (verifiedStoreId && storeId !== verifiedStoreId) {
    await withStore(verifiedStoreId, (tx) => tx.insert(s.auditLog).values({
      storeId: verifiedStoreId!, actor: 'system:webhook', entity: 'store_secret', entityId: 'stripe:webhookSecret',
      action: 'cross_tenant_signature_rejected',
      data: { eventId: event.id, eventType: event.type, verifiedStoreId, resolvedStoreId: storeId },
    })).catch(() => undefined); // best-effort — never let audit logging block the reject
    return c.json({ received: true }, 200);
  }

  // Zero-cache stock rule: reconcileStripeRefund never owns this transaction
  // (it runs on the `tx` this handler supplies) — it only REPORTS whether a
  // stock-affecting settlement happened via `stockChanged`. Fire the hook
  // once, after this whole claim transaction commits, never before.
  let stockChanged = false;
  let storeSlug: string | undefined;
  // D4-serialization: PaymentIntent events settle under the SAME per-order
  // advisory lock /pay, reconcileStripeOrder and the Sezzle recovery capture
  // take, so a Stripe settle and a concurrent Sezzle capture of the same order
  // are serialized (the loser sees the order no longer payable).
  const piOrderCode = event.type.startsWith('payment_intent.')
    ? (event.data.object as { metadata?: { orderCode?: string } }).metadata?.orderCode : undefined;
  const runClaim = (fn: () => Promise<void>) => piOrderCode ? withAdvisoryLock(`pay:${storeId}:${piOrderCode}`, fn) : fn();
  // X-45: an event that records provider-moved money runs under withLockedSet with mustCommit
  // (the provider has already moved the money, so the claim waits for its locks and never 409s).
  // Events with no stored order keep the plain withStore path.
  const moneySubjects = await moneyLockSubjects(storeId, event);
  const runMoney = (fn: (tx: Tx) => Promise<void>): Promise<void> => moneySubjects.length
    ? withLockedSet(storeId, moneySubjects, (tx) => fn(tx), { mustCommit: true })
    : withStore(storeId, fn);
  await runClaim(() => runMoney(async (tx) => {
    // ra-sec: bind the verifying secret's mode to the store's configured mode. A
    // webhook signed with the TEST secret must not drive payment_intent.succeeded
    // on a LIVE store (a leaked test webhook secret would otherwise let a forged
    // event settle a live order). Mismatch → ack + ignore.
    const [store] = await tx.select({ config: s.store.config, slug: s.store.slug }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
    if (!store) return;
    if (stripeModeFromConfig(store.config) !== verifiedMode) {
      // D9: still ack (a forged/stale-mode event must not be processed), but
      // never silently — the store may have flipped test<->live with PIs in
      // flight. Audit before the 200 so an operator can reconcile.
      await recordPaymentAlert(tx, storeId, {
        kind: 'stripe_mode_mismatch', email: false, actor: 'stripe:webhook', orderId: null,
        orderCode: (event.data.object as { metadata?: { orderCode?: string } }).metadata?.orderCode ?? null,
        providerRef: (event.data.object as { id?: string }).id ?? null, amount: null, currency: null,
        detail: `Stripe ${verifiedMode}-mode event ignored: store is configured for ${stripeModeFromConfig(store.config)} mode`,
        data: { eventId: event.id, eventType: event.type, verifiedMode },
      });
      return;
    }
    storeSlug = store.slug;
    // Idempotency: claim the event id. A duplicate delivery is a no-op.
    const claimed = await tx
      .insert(s.processedEvent)
      .values({ id: event.id, storeId, type: event.type })
      .onConflictDoNothing()
      .returning({ id: s.processedEvent.id });
    if (claimed.length === 0) return;

    switch (event.type) {
      // D1/D3/D4/D10: every PaymentIntent lifecycle event goes through the
      // shared applyStripeIntent — the same idempotent path the pull-based
      // fallback (reconcileStripeOrder) uses. succeeded settles (MONEY-3/4
      // semantics unchanged); a verify failure or a duplicate capture is
      // recorded + alerted instead of dropped; payment_failed/canceled release
      // the tracked attempt; processing/requires_action hold it.
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
      case 'payment_intent.processing':
      case 'payment_intent.requires_action': {
        const pi = event.data.object as unknown as StripeIntent;
        if (!pi.metadata?.orderCode) return;
        await applyStripeIntent(tx, storeId, pi, verifiedMode, { actor: 'stripe:webhook' });
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
        if (pi && r.id) {
          const result = await reconcileStripeRefund(tx, storeId, {
            reId: r.id, amount: r.amount, status: r.status, piId: pi,
            attemptId: r.metadata?.[STRIPE_REFUND_ATTEMPT_KEY] ?? null,
          }, { mode: verifiedMode });
          if (result.stockChanged) stockChanged = true;
        }
        return;
      }
      case 'charge.refunded': {
        const ch = event.data.object as unknown as { payment_intent?: string | { id?: string }; refunds?: { data?: Array<{ id: string; amount: number; status: string; payment_intent?: string | { id?: string }; metadata?: Record<string, string> | null }> } };
        const chPi = typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id;
        for (const r of ch.refunds?.data ?? []) {
          const pi = (typeof r.payment_intent === 'string' ? r.payment_intent : r.payment_intent?.id) ?? chPi;
          if (pi && r.id) {
            const result = await reconcileStripeRefund(tx, storeId, {
              reId: r.id, amount: r.amount, status: r.status, piId: pi,
              attemptId: r.metadata?.[STRIPE_REFUND_ATTEMPT_KEY] ?? null,
            }, { mode: verifiedMode });
            if (result.stockChanged) stockChanged = true;
          }
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
        await onInvoicePaid(tx, storeId, invoice, { mode: verifiedMode });
        // SR-03: subscription payments are minted inside subscriptions.ts
        // (settleFirstCycle + renewal insert) with no gateway metadata — the
        // verifying signature's mode is the only trusted source. Backfill it
        // on the ledger row this invoice settled; the (store, provider_ref)
        // stripe dedupe index makes a redelivery a no-op, and the IS NULL
        // guard never overwrites an already-persisted identity.
        const invoiceRef = (typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id) ?? invoice.id;
        if (invoiceRef) {
          // Chokepoint operation `payment_mode_corrected` (monotone: only fills a NULL gateway_mode).
          const [pay] = await tx.select({ id: s.payment.id }).from(s.payment)
            .where(and(eq(s.payment.providerRef, invoiceRef), eq(s.payment.method, 'stripe'), isNull(s.payment.gatewayMode))).limit(1);
          if (pay) {
            await recordSettlementOperation(tx, {
              storeId, kind: 'payment_mode_corrected', operationId: pay.id, effects: [],
              mutations: [{ type: 'payment_gateway_identity', paymentId: pay.id, gatewayMode: verifiedMode }],
            });
          }
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
  }));
  if (stockChanged && storeSlug) onStockChanged(storeSlug);
  return c.json({ received: true }, 200);
});
