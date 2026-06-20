/**
 * Subscription lifecycle — the issue-then-extend heart. A subscription IS a
 * backing SellRight order whose payment recurs:
 *   - checkout.session.completed → upsert our `subscription` row (incomplete)
 *   - invoice.paid (first cycle)  → settle the backing order via the EXISTING
 *     applyPaymentResult path (→ Paid → issueLicensesForPaidOrder), then link
 *     the issued license to the subscription
 *   - invoice.paid (renewal)      → extend the license's expiresAt + updatesUntil
 *     by the variant's duration days (extendEntitlement)
 *   - invoice.payment_failed      → past_due (dunning — no revoke)
 *   - customer.subscription.updated/deleted → sync status / cancel state
 *
 * Non-route module (keeps the no-unscoped-db-in-routes rule): every function is
 * tx-scoped; the route owns the idempotency claim + withStore. Stripe events are
 * NOT ordered, so onInvoicePaid CREATE-OR-FINDs the subscription rather than
 * assuming checkout.session.completed ran first.
 */
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { applyPaymentResult } from './settle.js';
import { extendEntitlement } from '../licensing/renewal.js';
import type { PaymentResult } from './provider.js';

// ── minimal Stripe shapes (kept SDK-light + testable) ────────────────────────
export interface CheckoutSessionLike {
  subscription?: string | { id?: string } | null;
  customer?: string | { id?: string } | null;
  metadata?: { storeId?: string; orderCode?: string; customerId?: string } | null;
}
export interface InvoiceLike {
  id: string;
  subscription?: string | { id?: string } | null;
  customer?: string | { id?: string } | null;
  payment_intent?: string | { id?: string } | null;
  billing_reason?: string | null;
  amount_paid?: number | null;
  subscription_details?: { metadata?: { storeId?: string; orderCode?: string; customerId?: string } | null } | null;
  lines?: { data?: Array<{ price?: { id?: string } | null; period?: { end?: number } | null }> } | null;
}
export interface SubscriptionObjLike {
  id: string;
  status?: string | null;
  customer?: string | { id?: string } | null;
  cancel_at_period_end?: boolean | null;
  current_period_end?: number | null;
  items?: { data?: Array<{ price?: { id?: string } | null }> } | null;
}

const idOf = (v: string | { id?: string } | null | undefined): string | null =>
  typeof v === 'string' ? v : v?.id ?? null;
const epochToDate = (e: number | null | undefined): Date | null => (e ? new Date(e * 1000) : null);

/** Map a Stripe subscription status onto our enum (incomplete | active | past_due | canceled). */
function mapStatus(stripeStatus: string | null | undefined): 'incomplete' | 'active' | 'past_due' | 'canceled' {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'incomplete';
  }
}

const priceOfInvoice = (inv: InvoiceLike): string | null => inv.lines?.data?.[0]?.price?.id ?? null;
const periodEndOfInvoice = (inv: InvoiceLike): Date | null => epochToDate(inv.lines?.data?.[0]?.period?.end);
const priceOfSub = (sub: SubscriptionObjLike): string | null => sub.items?.data?.[0]?.price?.id ?? null;

/** Look up our subscription row by Stripe subscription id (store-scoped via RLS). */
async function findSubBySubId(tx: Tx, subId: string) {
  const [row] = await tx.select().from(s.subscription).where(eq(s.subscription.stripeSubscriptionId, subId)).limit(1);
  return row ?? null;
}

/** Resolve the backing order id from an orderCode (store-scoped via RLS). */
async function orderIdByCode(tx: Tx, code: string | undefined | null): Promise<string | null> {
  if (!code) return null;
  const [o] = await tx.select({ id: s.order.id }).from(s.order).where(eq(s.order.code, code)).limit(1);
  return o?.id ?? null;
}

async function audit(tx: Tx, storeId: string, action: string, subId: string | null, data: Record<string, unknown>): Promise<void> {
  await tx.insert(s.auditLog).values({ storeId, actor: 'stripe:webhook', entity: 'subscription', entityId: subId, action, data });
}

/**
 * checkout.session.completed — upsert the subscription row (incomplete). This is
 * the canonical create event (session metadata is OURS, no propagation needed).
 */
export async function onCheckoutCompleted(tx: Tx, storeId: string, session: CheckoutSessionLike): Promise<void> {
  const subId = idOf(session.subscription);
  if (!subId) return; // a non-subscription checkout session — ignore
  const customerId = session.metadata?.customerId ?? null;
  const orderId = await orderIdByCode(tx, session.metadata?.orderCode);
  const stripeCustomerId = idOf(session.customer);
  const existing = await findSubBySubId(tx, subId);
  if (existing) {
    await tx.update(s.subscription).set({
      stripeCustomerId: stripeCustomerId ?? existing.stripeCustomerId,
      customerId: existing.customerId ?? customerId,
      orderId: existing.orderId ?? orderId,
      updatedAt: new Date(),
    }).where(eq(s.subscription.id, existing.id));
  } else {
    await tx.insert(s.subscription).values({
      storeId, stripeSubscriptionId: subId, stripeCustomerId,
      customerId, orderId, status: 'incomplete',
    });
  }
  await audit(tx, storeId, 'subscription_checkout_completed', subId, { orderId, stripeCustomerId });
}

/** Read back the single license issued for an order (after settle). */
async function licenseForOrder(tx: Tx, orderId: string): Promise<{ id: string; orderLineId: string; expiresAt: Date | null; updatesUntil: Date | null } | null> {
  const [row] = await tx
    .select({ id: s.license.id, orderLineId: s.license.orderLineId, expiresAt: s.license.expiresAt, updatesUntil: s.license.updatesUntil })
    .from(s.license).where(eq(s.license.orderId, orderId)).limit(1);
  return row ?? null;
}

/**
 * invoice.paid — CREATE-OR-FIND the subscription (events are unordered), then:
 *  - first cycle (no linked license): settle the backing order via the existing
 *    applyPaymentResult (issues the license), then link license → subscription.
 *  - renewal cycle (license linked): extend the license entitlement dates.
 * Always sets status=active + currentPeriodEnd. Writes an amount-mismatch audit
 * row when invoice.amount_paid != order.grandTotal (operator-visible, not trusted).
 */
export async function onInvoicePaid(tx: Tx, storeId: string, invoice: InvoiceLike): Promise<void> {
  const subId = idOf(invoice.subscription);
  if (!subId) return;
  // create-or-find — never assume checkout.session.completed already ran.
  let sub = await findSubBySubId(tx, subId);
  if (!sub) {
    const orderId = await orderIdByCode(tx, invoice.subscription_details?.metadata?.orderCode);
    const customerId = invoice.subscription_details?.metadata?.customerId ?? null;
    const [inserted] = await tx.insert(s.subscription).values({
      storeId, stripeSubscriptionId: subId, stripeCustomerId: idOf(invoice.customer),
      customerId, orderId, priceId: priceOfInvoice(invoice), status: 'incomplete',
    }).returning();
    sub = inserted!;
    await audit(tx, storeId, 'subscription_created_from_invoice', subId, { orderId });
  }

  const currentPeriodEnd = periodEndOfInvoice(invoice);
  const priceId = priceOfInvoice(invoice) ?? sub.priceId;

  if (!sub.licenseId) {
    // FIRST CYCLE — settle the backing order through the EXISTING settle path.
    if (!sub.orderId) {
      await audit(tx, storeId, 'subscription_invoice_no_order', subId, { invoiceId: invoice.id });
      // No backing order to settle; still record period + status so renewals work.
      await tx.update(s.subscription).set({ status: 'active', currentPeriodEnd, priceId, updatedAt: new Date() }).where(eq(s.subscription.id, sub.id));
      return;
    }
    const [order] = await tx
      .select({ id: s.order.id, state: s.order.state, grandTotal: s.order.grandTotal, currency: s.order.currency, customerId: s.order.customerId })
      .from(s.order).where(eq(s.order.id, sub.orderId)).limit(1);
    if (order) {
      const result: PaymentResult = {
        state: 'Settled',
        providerRef: idOf(invoice.payment_intent) ?? invoice.id,
        metadata: { stripeInvoiceId: invoice.id, amountPaid: invoice.amount_paid ?? null },
      };
      // applyPaymentResult no-ops the transition if the order is already Paid (a
      // duplicate invoice.paid re-settle), and issueLicensesForPaidOrder's own
      // per-orderLine guard prevents a double-issue.
      await applyPaymentResult(tx, { storeId, order, method: 'stripe', result });
      if (invoice.amount_paid != null && invoice.amount_paid !== order.grandTotal) {
        await audit(tx, storeId, 'subscription_amount_mismatch', subId, { invoiceId: invoice.id, amountPaid: invoice.amount_paid, grandTotal: order.grandTotal });
      }
      const lic = await licenseForOrder(tx, order.id);
      await tx.update(s.subscription).set({
        licenseId: lic?.id ?? null, status: 'active', currentPeriodEnd, priceId, updatedAt: new Date(),
      }).where(eq(s.subscription.id, sub.id));
      await audit(tx, storeId, 'subscription_activated', subId, { orderId: order.id, licenseId: lic?.id ?? null });
    }
    return;
  }

  // RENEWAL CYCLE — extend the linked license's entitlement dates.
  const [lic] = await tx
    .select({ id: s.license.id, orderLineId: s.license.orderLineId, expiresAt: s.license.expiresAt, updatesUntil: s.license.updatesUntil })
    .from(s.license).where(eq(s.license.id, sub.licenseId)).limit(1);
  if (lic) {
    const [variant] = await tx
      .select({ licenseDurationDays: s.productVariant.licenseDurationDays, updatesDurationDays: s.productVariant.updatesDurationDays })
      .from(s.orderLine)
      .innerJoin(s.productVariant, eq(s.productVariant.id, s.orderLine.variantId))
      .where(eq(s.orderLine.id, lic.orderLineId)).limit(1);
    const now = new Date();
    const expiresAt = extendEntitlement(lic.expiresAt, variant?.licenseDurationDays ?? null, now);
    const updatesUntil = extendEntitlement(lic.updatesUntil, variant?.updatesDurationDays ?? null, now);
    await tx.update(s.license).set({ expiresAt, updatesUntil, updatedAt: now }).where(eq(s.license.id, lic.id));
    await audit(tx, storeId, 'subscription_renewed', subId, { licenseId: lic.id, expiresAt, updatesUntil });
  }
  await tx.update(s.subscription).set({ status: 'active', currentPeriodEnd, priceId, updatedAt: new Date() }).where(eq(s.subscription.id, sub.id));
}

/** invoice.payment_failed — past_due (dunning). Do NOT revoke the license. */
export async function onInvoiceFailed(tx: Tx, storeId: string, invoice: InvoiceLike): Promise<void> {
  const subId = idOf(invoice.subscription);
  if (!subId) return;
  const sub = await findSubBySubId(tx, subId);
  if (!sub) return; // no row yet — nothing to mark
  await tx.update(s.subscription).set({ status: 'past_due', updatedAt: new Date() }).where(eq(s.subscription.id, sub.id));
  await audit(tx, storeId, 'subscription_payment_failed', subId, { invoiceId: invoice.id });
}

/** customer.subscription.updated — sync status / cancelAtPeriodEnd / currentPeriodEnd. */
export async function onSubscriptionUpdated(tx: Tx, storeId: string, sub: SubscriptionObjLike): Promise<void> {
  const row = await findSubBySubId(tx, sub.id);
  if (!row) return;
  await tx.update(s.subscription).set({
    status: mapStatus(sub.status),
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    currentPeriodEnd: epochToDate(sub.current_period_end) ?? row.currentPeriodEnd,
    priceId: priceOfSub(sub) ?? row.priceId,
    updatedAt: new Date(),
  }).where(eq(s.subscription.id, row.id));
  await audit(tx, storeId, 'subscription_updated', sub.id, { status: mapStatus(sub.status), cancelAtPeriodEnd: sub.cancel_at_period_end ?? false });
}

/** customer.subscription.deleted — canceled; the license lapses at expiresAt. */
export async function onSubscriptionDeleted(tx: Tx, storeId: string, sub: SubscriptionObjLike): Promise<void> {
  const row = await findSubBySubId(tx, sub.id);
  if (!row) return;
  await tx.update(s.subscription).set({ status: 'canceled', updatedAt: new Date() }).where(eq(s.subscription.id, row.id));
  await audit(tx, storeId, 'subscription_canceled', sub.id, {});
}
