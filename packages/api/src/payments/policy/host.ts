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
  PaymentPolicyRefusalError, PaymentPolicyVetoError, registeredPaymentPolicies, registerPaymentPolicy,
} from './registry.js';
import type {
  AuthorizeInvoiceEffectInput, BeforeCaptureInput, BeforeCaptureResult, BeforePaymentAttemptInput, CheckoutLine,
  CheckoutEligibilityInput, CheckoutFingerprintBasis, CheckoutPriceAdjustment, CheckoutPromotionReplacement, CheckoutRefusal,
  CheckoutReplayInput, CheckoutRequestIntent, InvoiceEffectDecision, PaymentPolicy, PaymentProvider,
  PaymentPurpose, PolicyCustomer, PolicyOrder, ReservationRequest, RevalidateForIssuanceInput,
  RevalidateForIssuanceResult, SettlementResponseInput, SettlementResponseOverride, EntitlementReversalInput,
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

/** Order metadata keys the engine writes itself; a policy may not contribute them. */
const ENGINE_METADATA_KEYS = new Set(['linked_via', 'contact', 'taxInclusive', 'checkoutFingerprint', 'legal_acceptance', 'loyalty']);

/** A policy's metadata or price adjustment is malformed or collides with another contribution. Fails the checkout closed. */
export class PaymentPolicyMetadataError extends Error {
  constructor(readonly policyId: string, readonly key: string, reason: string) {
    super(`payment policy "${policyId}" metadata "${key}": ${reason}`);
    this.name = 'PaymentPolicyMetadataError';
  }
}

/**
 * Validates the checkout request's `extensions` object (PAYMENT-TIMING X-57). Every key must name a registered
 * policy that declares `checkoutExtensions`, and each declared block is parsed by its schema (a missing block is
 * parsed as undefined, so a required block fails). The returned value holds only the parsed blocks, so the
 * idempotency fingerprint is computed over canonical data. Pure; safe to call before the transaction.
 */
export function parseCheckoutExtensions(input: Readonly<Record<string, unknown>> | undefined):
  { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const declared = policies().filter((p) => p.checkoutExtensions);
  const raw = input ?? {};
  for (const key of Object.keys(raw)) {
    if (!declared.some((p) => p.id === key)) return { ok: false, reason: `unknown extension "${key}"` };
  }
  const value: Record<string, unknown> = {};
  for (const p of declared) {
    const parsed = p.checkoutExtensions!.safeParse(raw[p.id]);
    if (!parsed.success) return { ok: false, reason: `invalid extension "${p.id}"` };
    if (parsed.data !== undefined) value[p.id] = parsed.data;
  }
  return { ok: true, value };
}

/** A refusal's status must be 409 or 422 and its code and message non-empty; anything else fails the checkout closed. */
function validRefusal(policyId: string, r: CheckoutRefusal): CheckoutRefusal {
  if (r.status !== 409 && r.status !== 422) throw new PaymentPolicyMetadataError(policyId, r.code, 'refusal status must be 409 or 422');
  if (!r.code.trim() || !r.message.trim()) throw new PaymentPolicyMetadataError(policyId, r.code, 'refusal code and message are required');
  return r.extra ? { status: r.status, code: r.code, message: r.message, extra: { ...r.extra } } : { status: r.status, code: r.code, message: r.message };
}

/**
 * Runs every registered policy's checkoutEligibility in registration order, each in SAVEPOINT policy_hook, before any
 * discount, loyalty or tax step. The first refusal throws PaymentPolicyRefusalError (the whole checkout rolls back).
 * No policy with the hook means no change.
 */
export async function runCheckoutEligibility(tx: Tx, i: Omit<CheckoutEligibilityInput, 'extensions'> & { extensions: Readonly<Record<string, unknown>> }): Promise<void> {
  await assertHeld(tx, i.held);
  for (const policy of policies()) {
    if (!policy.checkoutEligibility) continue;
    const result = await inSavepoint(tx, policy.id, () => policy.checkoutEligibility!(tx, {
      storeId: i.storeId, currency: i.currency, lines: i.lines, extensions: i.extensions[policy.id], customer: i.customer, intent: i.intent, held: i.held,
    }));
    if (!result.ok) throw new PaymentPolicyRefusalError(validRefusal(policy.id, result.refusal));
  }
}

export interface CheckoutOrderOutcome {
  /** Metadata to merge into order.metadata (already validated for collisions). */
  readonly metadata: Record<string, unknown>;
  /** Price adjustments in registration order; the engine writes each as an order_adjustment row. */
  readonly adjustments: readonly (CheckoutPriceAdjustment & { readonly policyId: string })[];
  /** The promotion replacement a policy asked for, or null. At most one policy may ask. */
  readonly promotionReplacement: CheckoutPromotionReplacement | null;
}

/**
 * Runs every registered policy's onCheckoutOrder inside the checkout transaction, right after the order and line
 * inserts. The first veto throws PaymentPolicyVetoError (the whole checkout rolls back). Reserve requests are
 * unioned and created under the held set; metadata and price adjustments are collected for the engine to apply.
 */
export async function runOnCheckoutOrder(tx: Tx, i: {
  order: PolicyOrder; lines: readonly CheckoutLine[]; extensions: Readonly<Record<string, unknown>>;
  customer: PolicyCustomer | null; intent: CheckoutRequestIntent; held: HeldLocks;
}): Promise<CheckoutOrderOutcome> {
  await assertHeld(tx, i.held);
  const requests: { policyId: string; request: ReservationRequest }[] = [];
  const metadata: Record<string, unknown> = {};
  const metadataOwner = new Map<string, string>();
  const adjustments: (CheckoutPriceAdjustment & { policyId: string })[] = [];
  let promotionReplacement: { policyId: string; replacement: CheckoutPromotionReplacement } | null = null;
  for (const policy of policies()) {
    if (!policy.onCheckoutOrder) continue;
    const result = await inSavepoint(tx, policy.id, () => policy.onCheckoutOrder!(tx, {
      order: i.order, lines: i.lines, extensions: i.extensions[policy.id], customer: i.customer, intent: i.intent, held: i.held,
    }));
    if (result.veto && result.refusal) throw new PaymentPolicyMetadataError(policy.id, 'refusal', 'veto and refusal are mutually exclusive');
    if (result.veto) throw new PaymentPolicyVetoError(result.veto);
    if (result.refusal) throw new PaymentPolicyRefusalError(validRefusal(policy.id, result.refusal));
    for (const [key, value] of Object.entries(result.metadata ?? {})) {
      if (ENGINE_METADATA_KEYS.has(key)) throw new PaymentPolicyMetadataError(policy.id, key, 'engine-owned key');
      const owner = metadataOwner.get(key);
      if (owner !== undefined) throw new PaymentPolicyMetadataError(policy.id, key, `already set by policy ${owner}`);
      metadataOwner.set(key, policy.id);
      metadata[key] = value;
    }
    for (const request of result.reserve ?? []) requests.push({ policyId: policy.id, request });
    if (result.replacePromotion) {
      const { fixedDiscount } = result.replacePromotion;
      if (!Number.isInteger(fixedDiscount) || fixedDiscount < 0) throw new PaymentPolicyMetadataError(policy.id, 'replacePromotion', 'fixedDiscount must be a non-negative integer');
      if (promotionReplacement) throw new PaymentPolicyMetadataError(policy.id, 'replacePromotion', `promotion already replaced by policy ${promotionReplacement.policyId}`);
      promotionReplacement = { policyId: policy.id, replacement: { fixedDiscount } };
    }
    if (result.priceAdjustment) {
      const adj = result.priceAdjustment;
      if (!Number.isInteger(adj.amount) || adj.amount === 0) throw new PaymentPolicyMetadataError(policy.id, adj.code, 'adjustment amount must be a non-zero integer');
      if (!adj.label.trim()) throw new PaymentPolicyMetadataError(policy.id, adj.code, 'adjustment label is required');
      adjustments.push({ policyId: policy.id, code: adj.code, label: adj.label, amount: adj.amount });
    }
  }
  const seen = new Map<string, string>();
  for (const { policyId, request } of requests) {
    const key = `${request.kind}\u0000${request.ownerKey}`;
    const first = seen.get(key);
    if (first !== undefined) throw new PaymentPolicyCompositionError(request.kind, request.ownerKey, [first, policyId]);
    seen.set(key, policyId);
  }
  for (const { request } of requests) {
    await reserve(tx, i.held, {
      storeId: i.order.storeId, orderId: i.order.id, kind: request.kind, ownerKey: request.ownerKey,
      holder: request.holder ? { ...request.holder } : undefined,
      releaseOnFullRefund: request.releaseOnFullRefund ?? false, expiresAt: request.expiresAt ?? null,
    });
  }
  return { metadata, adjustments, promotionReplacement: promotionReplacement?.replacement ?? null };
}

/** True when a registered policy runs onCheckoutOrder, so it may replace the promotion after discount-dependent checks ran. */
export const hasCheckoutOrderPolicy = (): boolean => policies().some((p) => p.onCheckoutOrder);

/** True when a registered policy gates checkout replays (authorization or a legacy fingerprint), so a replay needs the stored order's own lock set. */
export const hasCheckoutReplayPolicy = (): boolean => policies().some((p) => p.checkoutReplayAllowed || p.legacyCheckoutFingerprint);

/** The refusal a bare `false` from checkoutReplayAllowed means; byte-identical to the engine's earlier fixed response. */
const REPLAY_REFUSED_CODE = 'LEGAL_ACCEPTANCE_REQUIRED';
const REPLAY_REFUSED_MESSAGE = 'checkout replay refused by payment policy';

/**
 * Consulted at every checkout idempotency replay site before the existing order is returned. Every policy that
 * declares checkoutReplayAllowed must allow. Policies run in registration order and the first refusal wins: `false`
 * is 422 LEGAL_ACCEPTANCE_REQUIRED with the generic message, a CheckoutReplayRefusal carries the policy's own message
 * (and optional code, status and extras). A hook failure throws PaymentPolicyUnavailableError (the replay is not served).
 */
export async function runCheckoutReplayAllowed(tx: Tx, i: Omit<CheckoutReplayInput, 'extensions'> & { extensions: Readonly<Record<string, unknown>> }): Promise<true | CheckoutRefusal> {
  await assertHeld(tx, i.held);
  for (const policy of policies()) {
    if (!policy.checkoutReplayAllowed) continue;
    const decision = await inSavepoint(tx, policy.id, () => policy.checkoutReplayAllowed!(tx, {
      existingOrder: i.existingOrder, extensions: i.extensions[policy.id], customer: i.customer, origin: i.origin, held: i.held,
    }));
    if (decision === true) continue;
    if (decision === false) return { status: 422, code: REPLAY_REFUSED_CODE, message: REPLAY_REFUSED_MESSAGE };
    return validRefusal(policy.id, { status: decision.status ?? 422, code: decision.code ?? REPLAY_REFUSED_CODE, message: decision.message, extra: decision.extra });
  }
  return true;
}

/**
 * The legacy fingerprint candidates the registered policies offer for a stored order, in registration order. Called
 * only after runCheckoutReplayAllowed returned true. The caller accepts a candidate only by exact equality with the
 * order's own stored fingerprint; nothing here reads or writes the stored value.
 */
export async function runLegacyCheckoutFingerprints(tx: Tx, i: {
  existingOrder: PolicyOrder; extensions: Readonly<Record<string, unknown>>; customer: PolicyCustomer | null;
  origin: 'idempotency_key' | 'unique_violation'; request: CheckoutFingerprintBasis; held: HeldLocks;
}): Promise<string[]> {
  await assertHeld(tx, i.held);
  const out: string[] = [];
  for (const policy of policies()) {
    if (!policy.legacyCheckoutFingerprint) continue;
    const candidate = await inSavepoint(tx, policy.id, () => policy.legacyCheckoutFingerprint!(tx, {
      existingOrder: i.existingOrder, extensions: i.extensions[policy.id], customer: i.customer, origin: i.origin, request: i.request, held: i.held,
    }));
    if (typeof candidate === 'string' && candidate) out.push(candidate);
  }
  return out;
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
 * Entitlement reversal (full refund or lost chargeback). Every registered policy's onEntitlementReversal runs in
 * registration order, each in SAVEPOINT policy_hook. A hook failure throws PaymentPolicyUnavailableError and the
 * caller (the effects handler) decides retry or terminal. Absent hooks are a no-op.
 */
export async function runEntitlementReversal(tx: Tx, input: EntitlementReversalInput): Promise<void> {
  await assertHeld(tx, input.held);
  for (const policy of policies()) {
    if (!policy.onEntitlementReversal) continue;
    await inSavepoint(tx, policy.id, () => policy.onEntitlementReversal!(tx, input));
  }
}

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
