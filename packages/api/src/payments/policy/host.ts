// Payment policy host (de-fork plan 3.4; PAYMENT-TIMING.md §3.1, §3.6, §3.7).
//
// Mirrors licensing/storekit/policy.ts: policies register at startup (createApp / plugin init),
// duplicate ids are a startup error, and every hook runs inside the caller's transaction.
//
// Composition: policies run in registration order. The first veto (or first terminal invoice decision,
// or first failed issuance revalidation) wins. `reserve` requests are unioned across policies; a duplicate
// (kind, ownerKey) is a composition error. Each hook runs in SAVEPOINT policy_hook: a SQL or runtime
// error inside plugin code rolls back to the savepoint and surfaces as PaymentPolicyUnavailableError
// (or, for response shaping, as "no override"), so the outer transaction is never left aborted.
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import {
  assertHeld, registerLockPlanContributor, withLockedSetInTx, type HeldLocks, type LockPlanContribution, type LockSubject,
} from '../../db/locks.js';
import * as s from '../../db/schema.js';
import { reserve, type ReservationRow } from '../reservation.js';
import {
  _resetPaymentPoliciesForTests, inSavepoint, PaymentPolicyCompositionError, PaymentPolicyUnavailableError,
  PaymentPolicyVetoError, registeredPaymentPolicies, registerPaymentPolicy,
} from './registry.js';
import type {
  AuthorizeInvoiceEffectInput, BeforeCaptureInput, BeforeCaptureResult, BeforePaymentAttemptInput, InvoiceEffectDecision,
  PaymentPolicy, PaymentProvider, PaymentPurpose, PolicyOrder, ReservationRequest, RevalidateForIssuanceInput,
  RevalidateForIssuanceResult, SettlementResponseInput, SettlementResponseOverride,
} from './types.js';

export {
  _resetPaymentPoliciesForTests, PAYMENT_POLICY_VETO_CODE, PaymentPolicyCompositionError, PaymentPolicyUnavailableError,
  PaymentPolicyVetoError, registeredPaymentPolicies, registerPaymentPolicy,
} from './registry.js';

// Policies are consulted through the registry, so registration order is the only composition rule.
const policies = (): readonly PaymentPolicy[] => registeredPaymentPolicies();

/**
 * Runs every registered policy's beforePaymentAttempt in registration order, inside the caller's
 * preparation transaction, then creates the reservations the allowing policies requested (R1, §3.3).
 * Throws PaymentPolicyVetoError on the first veto, PaymentPolicyUnavailableError on a hook failure, and
 * PaymentPolicyCompositionError when two policies request the same reservation identity.
 */
export async function runBeforePaymentAttempt(tx: Tx, input: BeforePaymentAttemptInput): Promise<void> {
  await assertHeld(tx, input.held);
  const requests: { policyId: string; request: ReservationRequest }[] = [];
  for (const policy of policies()) {
    const result = await inSavepoint(tx, policy.id, () => policy.beforePaymentAttempt(tx, input));
    if (!result.allow) throw new PaymentPolicyVetoError(result.veto);
    for (const request of result.reserve ?? []) requests.push({ policyId: policy.id, request });
  }
  if (!requests.length) return;
  const seen = new Map<string, string>();
  for (const { policyId, request } of requests) {
    const key = `${request.kind}\u0000${request.ownerKey}`;
    const first = seen.get(key);
    if (first !== undefined) throw new PaymentPolicyCompositionError(request.kind, request.ownerKey, [first, policyId]);
    seen.set(key, policyId);
  }
  for (const { request } of requests) {
    await reserve(tx, input.held, {
      storeId: input.order.storeId, orderId: input.order.id, kind: request.kind, ownerKey: request.ownerKey,
      holder: request.holder ? { ...request.holder } : undefined,
      releaseOnFullRefund: request.releaseOnFullRefund ?? false, expiresAt: request.expiresAt ?? null,
    });
  }
}

/**
 * Runs every registered policy's beforeCapture in registration order inside the caller's decision
 * transaction. The first `cancel` wins; otherwise the result is `capture`. A policy without the hook
 * allows. Throws PaymentPolicyUnavailableError on a hook failure (the capture must then not be issued).
 */
export async function runBeforeCapture(tx: Tx, input: BeforeCaptureInput): Promise<BeforeCaptureResult> {
  await assertHeld(tx, input.held);
  for (const policy of policies()) {
    if (!policy.beforeCapture) continue;
    const result = await inSavepoint(tx, policy.id, () => policy.beforeCapture!(tx, input));
    if (result.action === 'cancel') return result;
  }
  return { action: 'capture' };
}

/**
 * Subscription entitlement effect authorisation (PAYMENT-TIMING §4.5). The first `terminal` decision wins;
 * otherwise `apply`. Throws PaymentPolicyUnavailableError on a hook failure: the effects worker turns that
 * into a bounded retry, then terminal.
 */
export async function runAuthorizeInvoiceEffect(tx: Tx, input: AuthorizeInvoiceEffectInput): Promise<InvoiceEffectDecision> {
  await assertHeld(tx, input.held);
  for (const policy of policies()) {
    if (!policy.authorizeInvoiceEffect) continue;
    const decision = await inSavepoint(tx, policy.id, () => policy.authorizeInvoiceEffect!(tx, input));
    if (decision.decision === 'terminal') return decision;
  }
  return { decision: 'apply' };
}

/**
 * Issuance revalidation when an issuance effect executes (PAYMENT-TIMING §3.7.5). The first failure wins and
 * blocks issuance. Otherwise `ok`, carrying the merged metadata patch of the policies that returned one; the
 * same key patched by two policies is a PaymentPolicyCompositionError. Throws PaymentPolicyUnavailableError on
 * a hook failure (retry, then terminal).
 */
export async function runRevalidateForIssuance(tx: Tx, input: RevalidateForIssuanceInput): Promise<RevalidateForIssuanceResult> {
  await assertHeld(tx, input.held);
  const patches: { policyId: string; patch: Readonly<Record<string, unknown>> }[] = [];
  for (const policy of policies()) {
    if (!policy.revalidateForIssuance) continue;
    const result = await inSavepoint(tx, policy.id, () => policy.revalidateForIssuance!(tx, input));
    if (!result.ok) return result;
    if (result.metadataPatch) patches.push({ policyId: policy.id, patch: result.metadataPatch });
  }
  if (!patches.length) return { ok: true };
  const merged: Record<string, unknown> = {};
  const owner = new Map<string, string>();
  for (const { policyId, patch } of patches) {
    for (const [key, value] of Object.entries(patch)) {
      const first = owner.get(key);
      if (first !== undefined) throw new PaymentPolicyCompositionError('licence.metadata', key, [first, policyId]);
      owner.set(key, policyId);
      merged[key] = value;
    }
  }
  return { ok: true, metadataPatch: merged };
}

/**
 * /pay response shaping (PAYMENT-TIMING §4.2). The money is already recorded in this transaction, so a
 * failing hook must not roll the record back: it is treated as "no override" and the default success body
 * is returned. The first override wins.
 */
export async function runShapeSettlementResponse(tx: Tx, input: SettlementResponseInput): Promise<SettlementResponseOverride | null> {
  await assertHeld(tx, input.held);
  for (const policy of policies()) {
    if (!policy.shapeSettlementResponse) continue;
    try {
      const override = await inSavepoint(tx, policy.id, () => policy.shapeSettlementResponse!(tx, input));
      if (override) return override;
    } catch (e) {
      if (!(e instanceof PaymentPolicyUnavailableError)) throw e;
    }
  }
  return null;
}

// Every registered policy's lockPlan joins the engine's plan (STOREKIT §5.3). Read-only by contract.
registerLockPlanContributor(async (tx, subject: LockSubject) => {
  let out: LockPlanContribution = { purchases: [], licenseIds: [], orderIds: [], reservationIds: [] };
  for (const policy of policies()) {
    if (!policy.lockPlan) continue;
    const c = await inSavepoint(tx, policy.id, () => policy.lockPlan!(tx, subject));
    out = {
      purchases: [...out.purchases, ...c.purchases],
      licenseIds: [...out.licenseIds, ...c.licenseIds],
      orderIds: [...out.orderIds, ...c.orderIds],
      reservationIds: [...(out.reservationIds ?? []), ...(c.reservationIds ?? [])],
    };
  }
  return out;
});

/**
 * Entry point for payment paths: loads the order's reservations under the held lock set and runs
 * every policy. Call it inside the preparation transaction, after the order row is locked and
 * before any replay lookup, attempt insert, session or intent creation.
 */
export async function checkPaymentAttempt(tx: Tx, held: HeldLocks, a: {
  provider: PaymentProvider; purpose: PaymentPurpose; order: PolicyOrder;
}): Promise<void> {
  const reservations: ReservationRow[] = await tx.select().from(s.orderReservation)
    .where(and(eq(s.orderReservation.storeId, a.order.storeId), eq(s.orderReservation.orderId, a.order.id)));
  await runBeforePaymentAttempt(tx, {
    provider: a.provider, purpose: a.purpose, order: a.order, reservations, held,
  });
}

/**
 * Placement tender check (PAYMENT-TIMING §4.6): zero total, gift card, admin manual `markPaid` and order-edit
 * `record_payment`. Runs in the caller's transaction, inside the order's lock set (the caller's set when one
 * covers the order). A veto throws PaymentPolicyVetoError, so the caller's whole transaction rolls back.
 */
export async function checkPlacement(tx: Tx, storeId: string, order: PolicyOrder, provider: 'zero_total' | 'gift_card' | 'manual'): Promise<void> {
  await withLockedSetInTx(tx, storeId, { kind: 'order', orderId: order.id }, (inner, held) =>
    checkPaymentAttempt(inner, held, { provider, purpose: 'placement', order }));
}
