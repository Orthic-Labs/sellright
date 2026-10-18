import { importedFinancialReconciliationRequired, IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED } from '../../orders/imported-financial-reconciliation.js';
/**
 * Built-in effect handlers (de-fork plan 2.8). Each one is the body of what the
 * Paid / renewal paths used to call inline, moved behind the pending-effects
 * engine WITHOUT changing what it writes: same helpers, same order within an
 * operation (license_issue -> loyalty_earn -> notification),
 * same dedupe keys. Payloads are self-sufficient so the worker can run them
 * later (deferred mode) and they are versioned (`payload_version`).
 */
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { currentLockSet, lockSetCovers, withLockedSetInTx, type HeldLocks, type LockSubject } from '../../db/locks.js';
import * as s from '../../db/schema.js';
import { env } from '../../env.js';
import { normalizeEmail } from '../../auth/email.js';
import { applyLicenseMetadataPatch, issueLicensesForPaidOrder } from '../../licensing/issue.js';
import { reconcileEditedOrderLicenses } from '../../licensing/edit-reconcile.js';
import { extendEntitlement } from '../../licensing/renewal.js';
import { bootstrapAccountAndQueueAccessMail } from '../../licensing/account-bootstrap.js';
import { postPaidOrderRewards } from '../../loyalty/bonus.js';
import { settleDeferredEditEarnForOrder } from '../../loyalty/ledger.js';
import { emitEvent } from '../../webhooks/emit.js';
import { pickEmailAppKey } from '../../email/dispatch.js';
import { orderConfirmation as orderConfirmationTpl } from '../../email/templates.js';
import { enqueueEmail } from '../../email/outbox.js';
import { enqueuePush, buildOrderPushPayload, buildOrderLiveActivityPayload } from '../../push/outbox.js';
import { emitOrderPaidEvent, sendOrderConfirmationAndEnrol } from '../paid-effects.js';
import { runAuthorizeInvoiceEffect, runEntitlementReversal, runRevalidateForIssuance } from '../policy/host.js';
import { PaymentPolicyUnavailableError } from '../policy/registry.js';
import type { PolicyOrder } from '../policy/types.js';
import { resolveHeldReviewTasks, validIssuanceApproval } from './issuance-approval.js';
import { recordOperationLicense, registerEffectHandler, backoffSeconds, runningInline, type EffectOutcome, type EffectRow, type LocalEffectHandler } from './effects.js';

/** Mirror of email/dispatch.ts::parseAppMap (kept local: no internal export just for this path). */
function parseAppFromMap(raw: string | undefined, appKey: string | null | undefined): string | undefined {
  const key = appKey?.trim().toLowerCase();
  if (!key || !raw?.trim()) return undefined;
  for (const entry of raw.split(/[,\n;]/)) {
    const idx = entry.indexOf('=');
    if (idx <= 0) continue;
    if (entry.slice(0, idx).trim().toLowerCase() === key) return entry.slice(idx + 1).trim();
  }
  return undefined;
}

// ── payloads (version 1) ─────────────────────────────────────────────────────
export interface LicenseIssuePayload {
  orderId: string; customerId: string | null; paidAt: string;
  /** First-cycle invoice: link the issued licence to the subscription and persist it on the operation row. */
  link?: { operationKind: string; operationId: string; stripeSubscriptionId: string };
  /** false = link only (first-cycle invoice on an order that is not transitioning to Paid): no issuance. Default true. */
  issue?: boolean;
}
export interface EditReconcilePayload {
  orderId: string; customerId: string | null; paidAt: string;
  /** Who committed the edit that queued this reconcile; absent for money-driven reconciles (customer balance payments). */
  actorKind?: 'human' | 'agent';
  /** Fresh human approval of a held issuance (issuance-approval.ts); honoured only for this effect and order. */
  issuanceApprovedBy?: { adminUserId: string; email: string; at: string; effectId: string; orderId: string };
}
export interface LoyaltyEarnPayload {
  /** settle: account bootstrap THEN rewards (the async paid paths' order); checkout: rewards only (bootstrap is in its notification). */
  variant: 'settle' | 'checkout' | 'deferred_edit'; orderId: string; paidAt?: string;
}
export interface NotificationPayload { variant: 'settle' | 'checkout'; orderId: string; guestEmail?: string | null; itemCount?: number }
/** entitlement_reversal payload: the order whose entitlement is reversed, and why. Immutable identity fields only. */
export interface EntitlementReversalPayload { orderId: string; reason: 'full_refund' | 'chargeback' }

export interface LicenseExtendPayload { stripeSubscriptionId: string; invoiceId: string; noOrder?: boolean }

/** How long a renewal waits for its subscription's licence link before going terminal (live-mode webhook retry horizon). */
export const LICENSE_EXTEND_RETRY_HORIZON_MS = 72 * 3_600_000;

async function loadOrder(tx: Tx, storeId: string, orderId: string) {
  const [order] = await tx.select().from(s.order).where(and(eq(s.order.id, orderId), eq(s.order.storeId, storeId))).limit(1);
  if (!order) throw new Error('Paid order context is missing');
  return order;
}
async function loadStore(tx: Tx, storeId: string) {
  const [store] = await tx.select().from(s.store).where(eq(s.store.id, storeId)).limit(1);
  if (!store) throw new Error('Paid order context is missing');
  return store;
}

/**
 * Deferred effects can run after the order left the paid lifecycle (refund or
 * cancellation before the worker got to it). Fulfilment must never be applied
 * to such an order silently: the effect goes terminal for an admin to review.
 * Inline effects run in the transaction that just made the order Paid.
 */
const PAID_LIFECYCLE = new Set(['Paid', 'PartiallyRefunded']);
async function requirePaidLifecycle(tx: Tx, e: EffectRow, orderId: string): Promise<EffectOutcome> {
  const [row] = await tx.select({ state: s.order.state, metadata: s.order.metadata }).from(s.order)
    .where(and(eq(s.order.id, orderId), eq(s.order.storeId, e.storeId))).limit(1).for('update');
  if (!row) return { terminal: 'order_missing' };
  if (importedFinancialReconciliationRequired(row.metadata)) return { terminal: IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED };
  if (!PAID_LIFECYCLE.has(row.state)) return { terminal: `order_state_${row.state}` };
  return undefined;
}

// ── policy gates (PAYMENT-TIMING §3.7.5, §4.5) ──────────────────────────────
// The engine asks the registered policy before an entitlement changes. Money is never gated here:
// these hooks run in the effect's own transaction, after the payment is recorded.

/** Subscription invoice id an operation was recorded for ('stripe_invoice_paid:<invoice.id>'). */
const invoiceIdOf = (operationId: string) => operationId.replace(/^stripe_invoice_paid:/, '');

const policyOrderOf = (o: typeof s.order.$inferSelect): PolicyOrder => ({
  id: o.id, storeId: o.storeId, code: o.code, state: o.state, currency: o.currency,
  grandTotal: o.grandTotal, customerId: o.customerId, metadata: o.metadata,
});

/** Writes the policy's admin task as an audit row (the effect's admin_review row carries the code). */
async function auditPolicyTask(tx: Tx, e: EffectRow, task: { title: string; detail: string }, code: string): Promise<void> {
  await tx.insert(s.auditLog).values({
    storeId: e.storeId, actor: 'system:policy', entity: 'order_pending_effect', entityId: e.id,
    action: 'policy_admin_task', data: { title: task.title, detail: task.detail, code, effectKind: e.effectKind, operationId: e.operationId },
  });
}

/** A policy that cannot answer (SAVEPOINT-isolated failure) keeps the effect pending: a bounded retry, then terminal. */
async function guardPolicy(run: () => Promise<EffectOutcome>): Promise<EffectOutcome> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PaymentPolicyUnavailableError) return { retry: { reason: 'policy_unavailable' } };
    throw err;
  }
}

/** Outcome of the issuance gate: a terminal/retry outcome to return, or proceed (with the licence metadata patch). */
type IssuanceGate = { outcome: EffectOutcome } | { proceed: true; metadataPatch?: Readonly<Record<string, unknown>> };

/**
 * Issuance gate: a first-cycle subscription invoice is authorised first, then the order's reservations and
 * state are revalidated. Returns a terminal outcome, or proceed. A policy that cannot answer
 * (PaymentPolicyUnavailableError) is a bounded retry (the worker goes terminal after MAX_ATTEMPTS). A
 * composition conflict is not caught here: it throws, the effect's transaction rolls back and it retries.
 */
async function issuanceGate(tx: Tx, e: EffectRow, p: LicenseIssuePayload, held: HeldLocks): Promise<IssuanceGate> {
  try {
    if (p.link) {
      const [sub] = await tx.select().from(s.subscription)
        .where(and(eq(s.subscription.storeId, e.storeId), eq(s.subscription.stripeSubscriptionId, p.link.stripeSubscriptionId))).limit(1);
      const [lic] = await tx.select().from(s.license)
        .where(and(eq(s.license.storeId, e.storeId), eq(s.license.orderId, p.orderId))).limit(1);
      const order = await loadOrder(tx, e.storeId, p.orderId);
      const decision = await runAuthorizeInvoiceEffect(tx, {
        storeId: e.storeId, operationId: e.operationId, effectKind: 'issuance', cycle: 'first_cycle',
        invoice: { id: invoiceIdOf(e.operationId), subscriptionId: p.link.stripeSubscriptionId, paymentIntentId: null, billingReason: null, amountPaid: null, periodEnd: null },
        subscription: sub
          ? { id: sub.stripeSubscriptionId, status: sub.status, licenseId: sub.licenseId, orderId: sub.orderId }
          : { id: p.link.stripeSubscriptionId, status: 'absent', licenseId: null, orderId: null },
        license: lic ? { id: lic.id, status: lic.status, expiresAt: lic.expiresAt, updatesUntil: lic.updatesUntil, metadata: lic.metadata } : null,
        order: policyOrderOf(order), held,
      });
      if (decision.decision === 'terminal') {
        await auditPolicyTask(tx, e, decision.adminTask, decision.code);
        return { outcome: { terminal: decision.code } };
      }
    }
    const order = await loadOrder(tx, e.storeId, p.orderId);
    const reservations = await tx.select().from(s.orderReservation)
      .where(and(eq(s.orderReservation.storeId, e.storeId), eq(s.orderReservation.orderId, p.orderId)));
    const verdict = await runRevalidateForIssuance(tx, { order: policyOrderOf(order), reservations, held });
    if (!verdict.ok) {
      if (verdict.audit) {
        await tx.insert(s.auditLog).values({
          storeId: e.storeId, actor: 'system:policy', entity: 'order', entityId: p.orderId,
          action: verdict.audit.action, data: verdict.audit.data,
        });
      }
      return { outcome: { terminal: verdict.code } };
    }
    return { proceed: true, metadataPatch: verdict.metadataPatch };
  } catch (err) {
    if (err instanceof PaymentPolicyUnavailableError) return { outcome: { retry: { reason: 'policy_unavailable' } } };
    throw err;
  }
}

/**
 * Lock-order detector (PAYMENT-TIMING §3.5). An inline effect runs inside its settlement's transaction, after the
 * settlement has already locked rows. A lock-taking licence effect that is not covered by a set already held on
 * that transaction would take L2/L1 after L3/L4 (inversion) and cannot retry a deadlock (X-45). In test builds
 * this throws; production keeps the behaviour unchanged (the set is acquired in-transaction as before).
 */
async function assertInlineCovered(tx: Tx, storeId: string, subject: LockSubject, effectKind: string): Promise<void> {
  if (!runningInline(tx)) return;
  if (currentLockSet(tx) && (await lockSetCovers(tx, storeId, subject))) return;
  if (process.env.NODE_ENV === 'test') throw new Error(`inline lock-taking effect without a covering lock set: ${effectKind}`);
}

const licenseIssue: LocalEffectHandler = {
  async run(tx, e) {
    const p = e.payload as unknown as LicenseIssuePayload;
    // Link-only (issue === false) mirrors the first-cycle path of a subscription invoice that does not
    // transition the order: the existing licence (if any) is linked and the activation audited, nothing issued.
    if (p.issue === false) return linkLicense(tx, e, p, []);
    const blocked = await requirePaidLifecycle(tx, e, p.orderId);
    if (blocked) return blocked;
    // Issuance runs under the order's lock set (PAYMENT-TIMING §3.5): the policy gate and the issue see the
    // same locked rows. Inline effects pass through the settlement's own set.
    await assertInlineCovered(tx, e.storeId, { kind: 'order', orderId: p.orderId }, 'license_issue');
    return withLockedSetInTx(tx, e.storeId, { kind: 'order', orderId: p.orderId }, async (inner, held) => {
      const gate = await issuanceGate(inner, e, p, held);
      if ('outcome' in gate) return gate.outcome;
      const issued = await issueLicensesForPaidOrder(inner, { storeId: e.storeId, orderId: p.orderId, customerId: p.customerId ?? null, paidAt: new Date(p.paidAt) });
      if (gate.metadataPatch) await applyLicenseMetadataPatch(inner, { storeId: e.storeId, orderId: p.orderId }, gate.metadataPatch);
      return linkLicense(inner, e, p, issued);
    });
  },
};

/** Links the order's licence to a first-cycle subscription (when the payload asks) and returns the outcome. */
async function linkLicense(tx: Tx, e: EffectRow, p: LicenseIssuePayload, issued: unknown): Promise<EffectOutcome> {
  if (!p.link) return { done: { result: { issued } } };
  // First-cycle subscription invoice: link the (freshly issued or pre-existing) licence to the subscription.
  const [lic] = await tx.select({ id: s.license.id }).from(s.license)
    .where(and(eq(s.license.storeId, e.storeId), eq(s.license.orderId, p.orderId))).limit(1);
  await tx.update(s.subscription).set({ licenseId: lic?.id ?? null, updatedAt: new Date() })
    .where(and(eq(s.subscription.storeId, e.storeId), eq(s.subscription.stripeSubscriptionId, p.link.stripeSubscriptionId)));
  if (lic) await recordOperationLicense(tx, e.storeId, { kind: p.link.operationKind, id: p.link.operationId }, lic.id);
  await tx.insert(s.auditLog).values({
    storeId: e.storeId, actor: 'stripe:webhook', entity: 'subscription', entityId: p.link.stripeSubscriptionId,
    action: 'subscription_activated', data: { orderId: p.orderId, licenseId: lic?.id ?? null },
  });
  return { done: { result: { issued, licenseId: lic?.id ?? null } } };
}

/** Retry reason while an edit_reconcile would issue licences for a line the order has not paid for. */
export const EDIT_BALANCE_DUE = 'EDIT_BALANCE_DUE';

/** Amount still due on the CURRENT order (its locked row's grandTotal, not the payload's snapshot). */
async function editBalanceDue(tx: Tx, storeId: string, orderId: string): Promise<number> {
  const order = await loadOrder(tx, storeId, orderId);
  const { amountDueForOrder } = await import('../settle.js'); // lazy: settle -> settlement/record -> handlers (import cycle)
  return amountDueForOrder(tx, storeId, orderId, order.grandTotal);
}

/** Who is behind an edit_reconcile effect: a human (or a customer's payment), an agent, or an edit whose actor cannot be established. */
type EditPrincipal = { kind: 'human' | 'agent' | 'unresolved'; source?: 'payload' | 'edit_actor' | 'recorded'; reason?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINCIPAL_RESOLVED_ACTION = 'edit_principal_resolved';

/**
 * Decides who authorised an edit_reconcile effect before its new licences may issue.
 *  - payload.actorKind (written by every order-edit commit since the agent role): used as recorded.
 *  - not an order-edit commit (a customer's payment: its operation is not order_edit_balance_settled, or that operation
 *    recorded a payment row): a human-paid settlement, unchanged.
 *  - otherwise a legacy edit-originated effect with no principal: read the original edit's actor (order_edit.actor is the
 *    admin email) and its admin_user.kind; an agent, or anything that cannot be resolved, is not 'human'.
 * The first resolution is written to the audit log keyed by the effect id and read back on every later run, so a retry
 * decides identically even if the admin row changes meanwhile.
 */
async function resolveEditPrincipal(tx: Tx, e: EffectRow, p: EditReconcilePayload): Promise<EditPrincipal> {
  if (p.actorKind) return { kind: p.actorKind, source: 'payload' };
  if (e.operationKind !== 'order_edit_balance_settled') return { kind: 'human' };
  const [op] = await tx.select({ paymentId: s.settlementOperation.paymentId }).from(s.settlementOperation).where(and(
    eq(s.settlementOperation.storeId, e.storeId), eq(s.settlementOperation.operationKind, e.operationKind), eq(s.settlementOperation.operationId, e.operationId))).limit(1);
  if (op?.paymentId) return { kind: 'human' }; // a customer's payment cleared the edit's balance

  const [prior] = await tx.select({ data: s.auditLog.data }).from(s.auditLog).where(and(
    eq(s.auditLog.storeId, e.storeId), eq(s.auditLog.entity, 'order_pending_effect'), eq(s.auditLog.entityId, e.id),
    eq(s.auditLog.action, PRINCIPAL_RESOLVED_ACTION))).limit(1);
  const recorded = (prior?.data as { kind?: string } | null | undefined)?.kind;
  if (recorded === 'human' || recorded === 'agent' || recorded === 'unresolved') return { kind: recorded, source: 'recorded' };

  const decided = await lookupEditPrincipal(tx, e, p);
  await tx.insert(s.auditLog).values({
    storeId: e.storeId, actor: 'system:policy', entity: 'order_pending_effect', entityId: e.id,
    action: PRINCIPAL_RESOLVED_ACTION, data: { kind: decided.kind, editId: e.operationId, ...(decided.reason ? { reason: decided.reason } : {}) },
  });
  return decided;
}

async function lookupEditPrincipal(tx: Tx, e: EffectRow, p: EditReconcilePayload): Promise<EditPrincipal> {
  if (!UUID_RE.test(e.operationId)) return { kind: 'unresolved', source: 'edit_actor', reason: 'operation_id_not_an_edit' };
  const [edit] = await tx.select({ actor: s.orderEdit.actor }).from(s.orderEdit).where(and(
    eq(s.orderEdit.id, e.operationId), eq(s.orderEdit.storeId, e.storeId), eq(s.orderEdit.orderId, p.orderId))).limit(1);
  if (!edit) return { kind: 'unresolved', source: 'edit_actor', reason: 'edit_not_found' };
  if (!edit.actor) return { kind: 'unresolved', source: 'edit_actor', reason: 'edit_actor_missing' };
  const [admin] = await tx.select({ kind: s.adminUser.kind }).from(s.adminUser).where(eq(s.adminUser.email, normalizeEmail(edit.actor))).limit(1);
  if (!admin) return { kind: 'unresolved', source: 'edit_actor', reason: 'actor_not_an_admin' };
  if (admin.kind === 'human') return { kind: 'human', source: 'edit_actor' };
  if (admin.kind === 'agent') return { kind: 'agent', source: 'edit_actor' };
  return { kind: 'unresolved', source: 'edit_actor', reason: 'actor_kind_unknown' };
}

/**
 * X-49: the order set is taken on the effect's own transaction (withLockedSetInTx): a covering set already
 * held there passes through; otherwise the order's licence/order/reservation rows are locked in
 * class order on this same transaction. Inline effects run inside the settlement set; deferred
 * effects run in a plain transaction. No nested transaction is opened in either case.
 */
export const editReconcile: LocalEffectHandler = {
  async run(tx, e) {
    const p = e.payload as unknown as EditReconcilePayload;
    // Same lock set as before (a covering set is reused, else the order's rows are locked on this transaction); the
    // set's brand is what the issuance gate needs. Required revocations run first and are never gated: only the
    // issuance of edit-added licences asks the policy (PAYMENT-TIMING §4.3), exactly as license_issue does.
    return withLockedSetInTx(tx, e.storeId, { kind: 'order', orderId: p.orderId }, async (inner, held) => {
      const blocked = await requirePaidLifecycle(inner, e, p.orderId);
      if (blocked) return blocked;
      const state: { refused?: EffectOutcome } = {};
      // A human's explicit approval of a held issuance (POST .../effects/:id/approve-issuance) stands in for the principal check
      // below and nothing else: the policy gate still runs. Absent on every effect that was never held (no lookup then).
      const approval = p.issuanceApprovedBy ? await validIssuanceApproval(inner, e, p) : null;
      const r = await reconcileEditedOrderLicenses(inner, {
        storeId: e.storeId, orderId: p.orderId, customerId: p.customerId ?? null, paidAt: new Date(p.paidAt),
        gate: async () => {
          // An agent never issues entitlements: refuse the new rows (revocations above are unaffected) even if a route forgot its check.
          // A row queued by an order edit before actorKind existed has no recorded principal: resolve the edit's actor
          // (order_edit.actor -> admin_user.kind). An agent, or an edit whose actor cannot be resolved, holds for a human.
          const principal: EditPrincipal = approval ? { kind: 'human', source: 'recorded' } : await resolveEditPrincipal(inner, e, p);
          if (principal.kind !== 'human') {
            await inner.insert(s.auditLog).values({
              storeId: e.storeId, actor: 'system:policy', entity: 'order', entityId: p.orderId,
              action: principal.kind === 'agent' ? 'agent_issuance_refused' : 'edit_issuance_held_unresolved_principal',
              data: { operationId: e.operationId, effectId: e.id, ...(principal.source ? { source: principal.source } : {}), ...(principal.reason ? { reason: principal.reason } : {}) },
            });
            state.refused = { terminal: principal.kind === 'agent' ? 'AGENT_ISSUANCE_REFUSED' : 'EDIT_PRINCIPAL_UNRESOLVED' };
            return { ok: false };
          }
          // Entitlements follow money, on EVERY execution (inline, worker retry, approved or not): reconciliation covers every
          // current line of the order, and a later human edit may have added a licensed line left due (the order stays Paid).
          // Checked on the locked current order, only here (the hook runs just before NEW licence rows are inserted).
          // A bounded retry, not a terminal: nothing is consumed (an approval stays on the payload, the review task stays open)
          // and the effect issues once the balance is settled.
          if ((await editBalanceDue(inner, e.storeId, p.orderId)) > 0) { state.refused = { retry: { reason: EDIT_BALANCE_DUE } }; return { ok: false }; }
          const gate = await issuanceGate(inner, e, { orderId: p.orderId, customerId: p.customerId ?? null, paidAt: p.paidAt }, held);
          if ('outcome' in gate) { state.refused = gate.outcome; return { ok: false }; }
          return { ok: true, metadataPatch: gate.metadataPatch };
        },
      });
      if (state.refused) return state.refused;
      // The review task that announced the hold closes in the same transaction as this effect's `done`.
      if (approval) await resolveHeldReviewTasks(inner, e, approval);
      return { done: { result: { ...r, ...(approval ? { issuanceApprovedBy: approval.adminUserId } : {}) } } };
    });
  },
};

/**
 * Entitlement reversal (full refund or lost chargeback). Runs on the effect's own transaction under the order's lock set
 * (the policies' lockPlan contributes the licences). Policy hooks run in registration order; a policy that cannot answer
 * is a bounded retry, then terminal with an admin_review row (engine markRetryOrTerminal). The money and the order state
 * were recorded by the caller and are never touched here.
 */
const entitlementReversal: LocalEffectHandler = {
  async run(tx, e) {
    const p = e.payload as unknown as EntitlementReversalPayload;
    await assertInlineCovered(tx, e.storeId, { kind: 'order', orderId: p.orderId }, 'entitlement_reversal');
    return withLockedSetInTx(tx, e.storeId, { kind: 'order', orderId: p.orderId }, async (inner, held) => {
      try {
        await runEntitlementReversal(inner, { storeId: e.storeId, orderId: p.orderId, reason: p.reason, operationId: e.operationId, held });
      } catch (err) {
        if (err instanceof PaymentPolicyUnavailableError) return { retry: { reason: 'policy_unavailable' } };
        throw err;
      }
      return { done: { result: { reason: p.reason } } };
    });
  },
};

const loyaltyEarn: LocalEffectHandler = {
  async run(tx, e) {
    const p = e.payload as unknown as LoyaltyEarnPayload;
    const blocked = await requirePaidLifecycle(tx, e, p.orderId);
    if (blocked) return blocked;
    if (p.variant === 'deferred_edit') { await settleDeferredEditEarnForOrder(tx, e.storeId, p.orderId); return; }
    const order = await loadOrder(tx, e.storeId, p.orderId);
    const store = await loadStore(tx, e.storeId);
    // Async paid paths: attach/create the purchase account BEFORE crediting it (idempotent per order;
    // the claim mail is dedupeKey'd). The synchronous checkout bootstraps after its rewards instead.
    if (p.variant === 'settle') {
      await bootstrapAccountAndQueueAccessMail(tx, { storeId: e.storeId, orderId: order.id, existingCustomerId: order.customerId });
    }
    await postPaidOrderRewards(tx, {
      storeId: e.storeId, orderId: order.id, paidAt: order.placedAt ?? (p.paidAt ? new Date(p.paidAt) : new Date()), store,
    });
  },
};

/** Synchronous-checkout notification set: order.paid event, owner push + Live Activity, confirmation email. */
async function checkoutNotifications(tx: Tx, e: EffectRow, p: NotificationPayload): Promise<void> {
  const order = await loadOrder(tx, e.storeId, p.orderId);
  const store = await loadStore(tx, e.storeId);
  await emitEvent(tx, e.storeId, 'order.paid', { code: order.code, grandTotal: order.grandTotal, currency: order.currency });
  // Purchase -> account bootstrap for the synchronous paid paths (they never reach the settle-path
  // loyalty effect). Idempotent per order; a session/email-match checkout already carries customerId.
  await bootstrapAccountAndQueueAccessMail(tx, { storeId: e.storeId, orderId: order.id, existingCustomerId: order.customerId });
  await enqueuePush(tx, e.storeId, {
    topic: 'order.paid',
    payload: buildOrderPushPayload({ topic: 'order.paid', code: order.code, grandTotal: order.grandTotal, currency: order.currency }),
  });
  await enqueuePush(tx, e.storeId, {
    topic: 'order.paid', kind: 'live_activity',
    payload: buildOrderLiveActivityPayload({ code: order.code, grandTotal: order.grandTotal, currency: order.currency, itemCount: p.itemCount ?? 0 }),
  });
  // REL-4: confirmation goes through the email outbox, enqueued in the same txn.
  const [cust] = order.customerId
    ? await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, order.customerId)).limit(1)
    : [];
  const recipient = normalizeEmail(cust?.email ?? p.guestEmail ?? '');
  if (!recipient) return;
  const lines = await tx
    .select({ name: s.orderLine.variantName, quantity: s.orderLine.quantity, lineTotal: s.orderLine.lineTotal, appKey: s.productVariant.appKey })
    .from(s.orderLine).leftJoin(s.productVariant, eq(s.productVariant.id, s.orderLine.variantId))
    .where(eq(s.orderLine.orderId, order.id));
  const appKey = pickEmailAppKey(lines.map((line) => line.appKey));
  const fromEmail = env.EMAIL_FROM_BY_APP ? parseAppFromMap(env.EMAIL_FROM_BY_APP, appKey) ?? env.SMTP_FROM : env.SMTP_FROM;
  const storefrontUrl = env.STOREFRONT_URL_BY_APP ? parseAppFromMap(env.STOREFRONT_URL_BY_APP, appKey) ?? env.STOREFRONT_URL : env.STOREFRONT_URL;
  const rendered = orderConfirmationTpl(
    { name: store.name, currency: store.currency, storefrontUrl, fromEmail },
    { code: order.code, grandTotal: order.grandTotal, currency: order.currency, lines: lines.map(({ name, quantity, lineTotal }) => ({ name, quantity, lineTotal })) },
  );
  await enqueueEmail(tx, e.storeId, {
    kind: 'order_confirmation', recipient,
    payload: { to: recipient, from: fromEmail, subject: rendered.subject, html: rendered.html, text: rendered.text },
  });
}

const notification: LocalEffectHandler = {
  async run(tx, e) {
    const p = e.payload as unknown as NotificationPayload;
    const blocked = await requirePaidLifecycle(tx, e, p.orderId);
    if (blocked) return blocked;
    if (p.variant === 'checkout') { await checkoutNotifications(tx, e, p); return; }
    // Async paid paths (gateway settle, webhook reconcile, /pay, subscription first cycle).
    const order = await loadOrder(tx, e.storeId, p.orderId);
    await emitOrderPaidEvent(tx, e.storeId, order);
    await sendOrderConfirmationAndEnrol(tx, e.storeId, order.id);
    // Mobile push for the ASYNC paid paths; the synchronous checkout enqueues its own (checkout variant).
    // Mobile push (as main's settle path): only when the order has its human code.
    if (order.code) {
      await enqueuePush(tx, e.storeId, {
        topic: 'order.paid',
        payload: buildOrderPushPayload({ topic: 'order.paid', code: order.code, grandTotal: order.grandTotal, currency: order.currency }),
      });
    }
  },
};

const licenseExtend: LocalEffectHandler = {
  async run(tx, e) {
    const p = e.payload as unknown as LicenseExtendPayload;
    const [sub] = await tx.select().from(s.subscription)
      .where(and(eq(s.subscription.storeId, e.storeId), eq(s.subscription.stripeSubscriptionId, p.stripeSubscriptionId))).limit(1);
    // A renewal delivered before its first invoice linked a licence waits (mutating nothing),
    // with backoff, until the retry horizon; then terminal for an admin.
    if (!sub?.licenseId) {
      return { retry: { reason: 'licence_not_linked', delayMs: backoffSeconds(e.attempts) * 1000, horizonMs: LICENSE_EXTEND_RETRY_HORIZON_MS } };
    }
    // The licence row is locked before it is read or extended (PAYMENT-TIMING §3.5): the effect's own set.
    const licenseId = sub.licenseId;
    await assertInlineCovered(tx, e.storeId, { kind: 'checkout', sourceLicenseId: licenseId }, 'license_extend');
    return withLockedSetInTx(tx, e.storeId, { kind: 'checkout', sourceLicenseId: licenseId }, (inner, held) => extendLicence(inner, e, p, licenseId, held));
  },
};

/** Renewal body under the licence lock: policy authorisation first, then the extension (money is already recorded). */
async function extendLicence(tx: Tx, e: EffectRow, p: LicenseExtendPayload, licenseId: string, held: HeldLocks): Promise<EffectOutcome> {
  return guardPolicy(async () => {
    const [lic] = await tx.select().from(s.license).where(eq(s.license.id, licenseId)).limit(1);
    if (!lic) return { terminal: 'licence_missing' };
    const [sub] = await tx.select().from(s.subscription)
      .where(and(eq(s.subscription.storeId, e.storeId), eq(s.subscription.stripeSubscriptionId, p.stripeSubscriptionId))).limit(1);
    const [order] = lic.orderId == null ? [] : await tx.select().from(s.order)
      .where(and(eq(s.order.id, lic.orderId), eq(s.order.storeId, e.storeId))).limit(1);
    const decision = await runAuthorizeInvoiceEffect(tx, {
      storeId: e.storeId, operationId: e.operationId, effectKind: 'renewal_extension', cycle: 'renewal',
      invoice: { id: p.invoiceId, subscriptionId: p.stripeSubscriptionId, paymentIntentId: null, billingReason: null, amountPaid: null, periodEnd: null },
      subscription: sub
        ? { id: sub.stripeSubscriptionId, status: sub.status, licenseId: sub.licenseId, orderId: sub.orderId }
        : { id: p.stripeSubscriptionId, status: 'absent', licenseId: null, orderId: null },
      license: { id: lic.id, status: lic.status, expiresAt: lic.expiresAt, updatesUntil: lic.updatesUntil, metadata: lic.metadata },
      order: order ? policyOrderOf(order) : null, held,
    });
    if (decision.decision === 'terminal') {
      await auditPolicyTask(tx, e, decision.adminTask, decision.code);
      return { terminal: decision.code };
    }
    // A revoked licence is extended like any other (main's extendRenewal never checked status): the
    // renewal is the subscription's money and its record; revocation decisions stay with the operator.
    // orderLineId is nullable (orderless admin/storekit issuance); a subscription licence always originates from an order line.
    const [variant] = lic.orderLineId == null ? [undefined] : await tx
      .select({ licenseDurationDays: s.productVariant.licenseDurationDays, updatesDurationDays: s.productVariant.updatesDurationDays })
      .from(s.orderLine).innerJoin(s.productVariant, eq(s.productVariant.id, s.orderLine.variantId))
      .where(eq(s.orderLine.id, lic.orderLineId)).limit(1);
    // Extension is computed at EXECUTION time `t` from the licence's previous expiry (not Stripe's period end).
    const t = new Date();
    const expiresAt = extendEntitlement(lic.expiresAt, variant?.licenseDurationDays ?? null, t);
    const updatesUntil = extendEntitlement(lic.updatesUntil, variant?.updatesDurationDays ?? null, t);
    await tx.update(s.license).set({ expiresAt, updatesUntil, updatedAt: t }).where(eq(s.license.id, lic.id));
    const audit = (action: string, data: Record<string, unknown>) => tx.insert(s.auditLog).values({
      storeId: e.storeId, actor: 'stripe:webhook', entity: 'subscription', entityId: p.stripeSubscriptionId, action, data,
    });
    // Orphaned subscription: the extension was applied with no backing order (the money is in subscription_invoice_payment).
    if (p.noOrder) await audit('subscription_renewal_no_order', { invoiceId: p.invoiceId });
    await audit('subscription_renewed', { licenseId: lic.id, expiresAt, updatesUntil, invoiceId: p.invoiceId, effectId: e.id });
    return { done: { result: { licenseId: lic.id, expiresAt, updatesUntil, t } } };
  });
}

/** Every execution rechecks linked orders under their lock sets, including previously queued effects. */
function quarantineGuard(handler: LocalEffectHandler): LocalEffectHandler {
  return { async run(tx, e) {
    const orderIds = new Set<string>();
    const subjects: LockSubject[] = [];
    if (typeof e.payload.orderId === 'string') orderIds.add(e.payload.orderId);
    const [operation] = await tx.select({ orderId: s.settlementOperation.orderId }).from(s.settlementOperation)
      .where(and(eq(s.settlementOperation.storeId, e.storeId), eq(s.settlementOperation.operationKind, e.operationKind), eq(s.settlementOperation.operationId, e.operationId))).limit(1);
    if (operation?.orderId) orderIds.add(operation.orderId);
    if (typeof e.payload.stripeSubscriptionId === 'string') {
      const [sub] = await tx.select().from(s.subscription).where(and(eq(s.subscription.storeId, e.storeId), eq(s.subscription.stripeSubscriptionId, e.payload.stripeSubscriptionId))).limit(1);
      if (sub?.orderId) orderIds.add(sub.orderId);
      if (sub?.licenseId) {
        subjects.push({ kind: 'checkout', sourceLicenseId: sub.licenseId });
        const [license] = await tx.select({ orderId: s.license.orderId }).from(s.license).where(and(eq(s.license.storeId, e.storeId), eq(s.license.id, sub.licenseId))).limit(1);
        if (license?.orderId) orderIds.add(license.orderId);
      }
    }
    subjects.push(...[...orderIds].sort().map((orderId) => ({ kind: 'order' as const, orderId })));
    if (!subjects.length) return handler.run(tx, e);
    return withLockedSetInTx(tx, e.storeId, subjects, async (inner) => {
      for (const orderId of [...orderIds].sort()) {
        const [order] = await inner.select({ metadata: s.order.metadata }).from(s.order)
          .where(and(eq(s.order.storeId, e.storeId), eq(s.order.id, orderId))).limit(1).for('update');
        if (importedFinancialReconciliationRequired(order?.metadata)) return { terminal: IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED };
      }
      return handler.run(inner, e);
    });
  } };
}

let registered = false;
/** Idempotent; called by settlement.ts so any process that can record an operation can also execute inline. */
export function registerBuiltinEffectHandlers(): void {
  if (registered) return;
  registered = true;
  registerEffectHandler('license_issue', quarantineGuard(licenseIssue));
  registerEffectHandler('edit_reconcile', quarantineGuard(editReconcile));
  registerEffectHandler('loyalty_earn', quarantineGuard(loyaltyEarn));
  registerEffectHandler('notification', quarantineGuard(notification));
  registerEffectHandler('license_extend', quarantineGuard(licenseExtend));
  registerEffectHandler('entitlement_reversal', quarantineGuard(entitlementReversal));
}
