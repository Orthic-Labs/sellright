/**
 * Subscription lifecycle — the issue-then-extend heart (invoice.paid is one frozen
 * settlement operation per invoice; see recordInvoicePaid). A subscription IS a
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
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { amountDueForOrder, recordPaymentAfterCancel } from './settle.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { editBalanceEffects, paidOrderEffects, recordSettlementOperation, type SettlementMutation } from './settlement/record.js';
import type { EffectRequest } from './settlement/effects.js';
import { classificationForBillingReason, classifyInvoice, invoiceHistoryPolicy, type InvoiceKey } from './settlement/invoice.js';

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
  currency?: string | null;
  status_transitions?: { paid_at?: number | null } | null;
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

/** Webhook-derived context for the invoice operation (the verified signature's mode is the only trusted source). */
export interface InvoiceContext { mode?: 'test' | 'live'; accountId?: string }

export async function onInvoicePaid(tx: Tx, storeId: string, invoice: InvoiceLike, ctx: InvoiceContext = {}): Promise<void> {
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

  await recordInvoicePaid(tx, storeId, sub, invoice, ctx);

  // Common post-cycle write: mark active + sync the current period. Each arm
  // is responsible for its own arm-specific audit (subscription_activated /
  // subscription_renewed) so we can rebuild a per-event timeline from
  // auditLog without parsing state diffs.
  await tx.update(s.subscription).set({
    status: 'active',
    currentPeriodEnd: periodEndOfInvoice(invoice),
    priceId: priceOfInvoice(invoice) ?? sub.priceId,
    updatedAt: new Date(),
  }).where(eq(s.subscription.id, sub.id));
}

type SubscriptionRow = typeof s.subscription.$inferSelect;

/**
 * The `stripe_invoice_paid` operation (plan 2.8): ONE operation per invoice id,
 * recorded BEFORE any cycle dispatch, whichever path observes it and however
 * many times. The first observation classifies the invoice (invoice.ts: Stripe's
 * billing_reason; legacy/unknown reasons against the initial-invoice evidence)
 * and freezes the classification and its authorized effect set on the operation
 * row; every later observation is a replay that mutates nothing — so a
 * first-cycle invoice redelivered after the licence is linked can no longer be
 * mistaken for a renewal. Authorized entitlement: first_cycle = the backing
 * order's Paid transition (licence issue, loyalty, notification), renewal = one
 * `license_extend` effect (precondition checked at execution), adjustment = money
 * only. Money goes to `payment` on the backing order, or to
 * `subscription_invoice_payment` when there is none. The InvoiceHistoryPolicy port
 * (pre-adoption baseline) can hold or pre-apply an invoice instead.
 */
async function recordInvoicePaid(tx: Tx, storeId: string, sub: SubscriptionRow, invoice: InvoiceLike, ctx: InvoiceContext): Promise<void> {
  const subId = sub.stripeSubscriptionId;
  const [stored] = await tx.select({ id: s.settlementOperation.id, classification: s.settlementOperation.classification }).from(s.settlementOperation).where(and(
    eq(s.settlementOperation.storeId, storeId), eq(s.settlementOperation.operationKind, 'stripe_invoice_paid'), eq(s.settlementOperation.operationId, invoice.id),
  )).limit(1);
  if (stored) {
    // Replay: frozen. A differing observed classification is ignored and audited.
    const observed = classificationForBillingReason(invoice.billing_reason);
    if (observed && stored.classification && observed !== stored.classification) {
      await audit(tx, storeId, 'settlement_classification_replayed', subId, { invoiceId: invoice.id, stored: stored.classification, observed });
    }
    return;
  }

  const [order] = sub.orderId
    ? await tx.select().from(s.order).where(eq(s.order.id, sub.orderId)).limit(1)
    : [];
  const [priorFirst] = sub.orderId
    ? await tx.select({ id: s.settlementOperation.id }).from(s.settlementOperation).where(and(
        eq(s.settlementOperation.storeId, storeId), eq(s.settlementOperation.operationKind, 'stripe_invoice_paid'),
        eq(s.settlementOperation.classification, 'first_cycle'), eq(s.settlementOperation.orderId, sub.orderId))).limit(1)
    : [];
  const key: InvoiceKey = {
    storeId, accountId: ctx.accountId ?? 'default', mode: ctx.mode ?? 'live', invoiceId: invoice.id, stripeSubscriptionId: subId,
    local: { licenceLinked: sub.licenseId != null, priorFirstCycleForOrder: priorFirst != null },
  };
  const policy = invoiceHistoryPolicy();
  const classified = await classifyInvoice(tx, key, invoice.billing_reason);
  // Main's dispatch was licence-driven: with no licence linked (and no earlier first cycle for the order) a
  // cycle invoice is the first cycle (issue + link), never an extension of a licence that does not exist.
  const classification = classified.classification === 'renewal' && !key.local.licenceLinked && !key.local.priorFirstCycleForOrder
    ? 'first_cycle' as const : classified.classification;
  const hold = classification === classified.classification ? classified.hold : undefined;
  const decision = await policy.disposition(tx, key, classification);
  if (decision.disposition === 'pending_at_frontier' || decision.entitlementAction === 'defer' || decision.moneyAction === 'defer') {
    return; // not recorded until its invoice.paid arrives under the candidate
  }

  const providerRef = idOf(invoice.payment_intent) ?? invoice.id;
  const amountPaid = invoice.amount_paid ?? 0;
  const paidAt = epochToDate(invoice.status_transitions?.paid_at);
  const common = { storeId, kind: 'stripe_invoice_paid' as const, operationId: invoice.id, classification, provider: { account: key.accountId, mode: key.mode, ref: providerRef } };
  const review = (reason: string): EffectRequest => ({ kind: 'admin_review', payload: { reason, invoiceId: invoice.id, classification, disposition: decision.disposition, stripeSubscriptionId: subId } });
  const orphanRow = (extra: Record<string, unknown>) => ({
    storeId, orderId: sub.orderId ?? null, stripeAccountId: key.accountId, mode: key.mode, stripeSubscriptionId: subId,
    invoiceId: invoice.id, providerRef, amount: amountPaid, currency: invoice.currency?.toUpperCase() ?? null,
    state: 'Settled' as const, paidAt, billingReason: invoice.billing_reason ?? null, origin: 'live' as const,
    disposition: decision.disposition, frontierId: decision.frontierId ?? null,
    metadata: { orphan: true, reason: 'no_backing_order', ...extra },
  });
  // ledger row for a renewal / adjustment: on the backing order when there is one, else orderless
  const moneyMutation = (meta: Record<string, unknown>, backfilled = false): SettlementMutation => order
    ? { type: 'payment_insert', rows: [{
        storeId, orderId: order.id, amount: amountPaid, method: 'stripe', providerRef, state: 'Settled',
        gatewayMode: key.mode, currency: invoice.currency?.toUpperCase() ?? order.currency,
        ...(backfilled && paidAt ? { createdAt: paidAt } : {}),
        metadata: { stripeInvoiceId: invoice.id, ...meta },
      }] }
    : { type: 'invoice_payment_record', row: orphanRow(meta) };
  const heldMoney = decision.moneyAction === 'hold_money' || decision.moneyAction === 'none';

  // ── historical dispositions (pre-adoption baseline): never an automatic effect ──
  if (decision.disposition !== 'new') {
    const mutations: SettlementMutation[] = [];
    if (decision.moneyAction === 'record_order_payment' && order) mutations.push(moneyMutation({ billing_reason: invoice.billing_reason ?? null, backfilled: true, disposition: decision.disposition, frontier: decision.frontierId ?? null }, true));
    else if (decision.moneyAction === 'record_orderless' || (decision.moneyAction === 'record_order_payment' && !order)) mutations.push({ type: 'invoice_payment_record', row: { ...orphanRow({}), origin: 'historical_backfill' } });
    await recordSettlementOperation(tx, {
      ...common, disposition: decision.disposition, orderId: sub.orderId ?? undefined, mutations,
      effects: decision.disposition === 'applied' || decision.disposition === 'ignored_non_subscription' || decision.disposition === 'voided'
        ? [] : [review(decision.reason ?? decision.disposition)],
    });
    return;
  }

  if (classification === 'unresolved') {
    await recordSettlementOperation(tx, { ...common, disposition: 'unresolved', orderId: sub.orderId ?? undefined, mutations: [], effects: [review(hold ?? 'unresolved')] });
    return;
  }

  if (classification === 'first_cycle') {
    if (!order) {
      // formerly the silent `subscription_invoice_no_order` / `!order` returns: now an explicit hold
      await audit(tx, storeId, 'subscription_invoice_no_order', subId, { invoiceId: invoice.id });
      await recordSettlementOperation(tx, {
        ...common, orderId: sub.orderId ?? undefined,
        mutations: heldMoney ? [] : [{ type: 'invoice_payment_record', row: orphanRow({}) }],
        effects: [review('first-cycle invoice has no backing order')],
      });
      return;
    }
    // First cycle settles the backing order the way the settle path did (SETTLEMENT-OPS 4, main's settleFirstCycle):
    //  - a transition to Paid issues the licence (license_issue), loyalty and notification;
    //  - a payment on an order already in the paid lifecycle is a balance payment: the balance_payment audit,
    //    edit reconcile only once the balance is cleared, the deferred edit earn, and MONEY-4 on overpayment;
    //  - anything else records the money only (MONEY-4 when the order can no longer become Paid).
    // In every branch the subscription is linked to the order's licence (link-only: nothing issued here).
    const remaining = (await amountDueForOrder(tx, storeId, order.id, order.grandTotal)) - order.grandTotal;
    const payable = canTransition(order.state as OrderState, 'Paid');
    const transitions = payable && remaining <= 0;
    const balance = !payable && (order.state === 'Paid' || order.state === 'PartiallyRefunded') && remaining >= 0;
    const paidAtNow = new Date();
    const payment: SettlementMutation = { type: 'payment_insert', rows: [{
      storeId, orderId: order.id, amount: order.grandTotal, method: 'stripe', providerRef, state: 'Settled',
      gatewayMode: null, currency: order.currency, metadata: { stripeInvoiceId: invoice.id, amountPaid: invoice.amount_paid ?? null },
    }] };
    const link = { operationKind: 'stripe_invoice_paid', operationId: invoice.id, stripeSubscriptionId: subId };
    const issueLink = (issueNow: boolean): EffectRequest => ({ kind: 'license_issue', payload: {
      orderId: order.id, customerId: order.customerId ?? null, paidAt: paidAtNow.toISOString(), link, ...(issueNow ? {} : { issue: false }),
    } });
    const fanout = paidOrderEffects({ orderId: order.id, customerId: order.customerId ?? null, paidAt: paidAtNow, variant: 'settle' });
    const balanceEffects = editBalanceEffects({ orderId: order.id, customerId: order.customerId ?? null })
      .filter((e) => e.kind !== 'edit_reconcile' || remaining === 0);
    const recorded = await recordSettlementOperation(tx, {
      ...common, orderId: order.id,
      mutations: transitions ? [payment, { type: 'order_paid', orderId: order.id, placedAt: paidAtNow }] : [payment],
      effects: transitions ? [issueLink(true), fanout[1]!, fanout[2]!]
        : balance ? [issueLink(false), ...balanceEffects]
        : [issueLink(false)],
    });
    if (!recorded.created) return;
    if (balance) {
      await tx.insert(s.auditLog).values({
        storeId, actor: 'system:settle', entity: 'order', entityId: order.id,
        action: 'balance_payment', fromState: order.state, toState: order.state,
        data: { amount: order.grandTotal, method: 'stripe', providerRef },
      });
    }
    if (invoice.amount_paid != null && invoice.amount_paid !== order.grandTotal) {
      await audit(tx, storeId, 'subscription_amount_mismatch', subId, { invoiceId: invoice.id, amountPaid: invoice.amount_paid, grandTotal: order.grandTotal });
    }
    // MONEY-4: captured money on an order that can no longer transition to Paid (and is not a balance) is never silent
    if (!payable && !balance) {
      await recordPaymentAfterCancel(tx, storeId, order, { method: 'stripe', providerRef, amount: order.grandTotal });
    }
    return;
  }

  // renewal / adjustment
  const heldByLegacyReason = hold != null;
  if (classification === 'renewal') {
    // The renewal ledger row keeps main's shape: gateway identity and currency are not set on it.
    const renewalMoney: SettlementMutation = order
      ? { type: 'payment_insert', rows: [{ storeId, orderId: order.id, amount: amountPaid, method: 'stripe', providerRef, state: 'Settled', metadata: { stripeInvoiceId: invoice.id, renewal: true } }] }
      : moneyMutation({ renewal: true });
    const rec = await recordSettlementOperation(tx, {
      ...common, orderId: sub.orderId ?? undefined,
      mutations: [renewalMoney],
      effects: [{ kind: 'license_extend', payload: { stripeSubscriptionId: subId, invoiceId: invoice.id, ...(order ? {} : { noOrder: true }) } }],
    });
    if (order && rec.created && rec.paymentId === undefined) {
      // a second invoice carrying this payment reference: the ledger row already exists (main's duplicate audit)
      await audit(tx, storeId, 'subscription_renewal_payment_duplicate', subId, { invoiceId: invoice.id, providerRef });
    }
    return;
  }
  await audit(tx, storeId, 'subscription_invoice_adjustment', subId, { invoiceId: invoice.id, billingReason: invoice.billing_reason ?? null });
  await recordSettlementOperation(tx, {
    ...common, orderId: sub.orderId ?? undefined,
    mutations: [moneyMutation({ adjustment: true })],
    effects: heldByLegacyReason ? [review(hold!)] : [],
  });
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
