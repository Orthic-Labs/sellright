// Payment policy host (de-fork plan 3.4; PAYMENT-TIMING.md §3.1 composition and SAVEPOINT rules).
//
// Mirrors licensing/storekit/policy.ts: policies register at startup (createApp / plugin init),
// duplicate ids are a startup error, and every hook runs inside the caller's transaction.
//
// Composition: policies run in registration order; the first veto wins and throws
// PaymentPolicyVetoError, so the caller's transaction rolls back (no attempt row, no provider call).
// Each hook runs in SAVEPOINT policy_hook: a SQL or runtime error inside plugin code rolls back
// to the savepoint and surfaces as PaymentPolicyUnavailableError (-> 503 on payment routes),
// so the outer transaction is never left aborted.
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { assertHeld, type HeldLocks } from '../../db/locks.js';
import * as s from '../../db/schema.js';
import type {
  BeforeCaptureInput, BeforeCaptureResult, BeforePaymentAttemptInput, PaymentPolicy, PaymentProvider, PaymentPurpose, PolicyOrder, PolicyVeto,
} from './types.js';

/** Wire code for a veto that carries no code of its own (PAYMENT-TIMING §3.6). */
export const PAYMENT_POLICY_VETO_CODE = 'PAYMENT_POLICY_VETO';

/** A policy vetoed the attempt. The caller's transaction must roll back. */
export class PaymentPolicyVetoError extends Error {
  constructor(readonly veto: PolicyVeto) {
    super(veto.message);
    this.name = 'PaymentPolicyVetoError';
  }
}

/** A policy hook failed (SQL or runtime error). Nothing it wrote is persisted. */
export class PaymentPolicyUnavailableError extends Error {
  constructor(readonly policyId: string, readonly reason: unknown) {
    super(`payment policy "${policyId}" is unavailable`);
    this.name = 'PaymentPolicyUnavailableError';
  }
}

const policies: PaymentPolicy[] = [];

/** Register a payment policy. Startup error on a duplicate id. */
export function registerPaymentPolicy(p: PaymentPolicy): void {
  const existing = policies.find((x) => x.id === p.id);
  if (existing) throw new Error(`payment policy "${p.id}" is already registered`);
  policies.push(p);
}

/** Registered policies in registration order (diagnostics and tests). */
export function registeredPaymentPolicies(): readonly PaymentPolicy[] {
  return [...policies];
}

/** Test seam: drop every registration. */
export function _resetPaymentPoliciesForTests(): void {
  policies.length = 0;
}

async function inSavepoint<T>(tx: Tx, policyId: string, fn: () => Promise<T>): Promise<T> {
  await tx.execute(sql`SAVEPOINT policy_hook`);
  try {
    const out = await fn();
    await tx.execute(sql`RELEASE SAVEPOINT policy_hook`);
    return out;
  } catch (cause) {
    await tx.execute(sql`ROLLBACK TO SAVEPOINT policy_hook`);
    await tx.execute(sql`RELEASE SAVEPOINT policy_hook`);
    throw new PaymentPolicyUnavailableError(policyId, cause);
  }
}

/**
 * Runs every registered policy's beforePaymentAttempt in registration order, inside the
 * caller's preparation transaction. Returns normally when every policy allows.
 * Throws PaymentPolicyVetoError on the first veto, PaymentPolicyUnavailableError on a hook failure.
 */
export async function runBeforePaymentAttempt(tx: Tx, input: BeforePaymentAttemptInput): Promise<void> {
  await assertHeld(tx, input.held);
  for (const policy of policies) {
    const result = await inSavepoint(tx, policy.id, () => policy.beforePaymentAttempt(tx, input));
    if (!result.allow) throw new PaymentPolicyVetoError(result.veto);
  }
}

/**
 * Runs every registered policy's beforeCapture in registration order inside the caller's decision
 * transaction. The first `cancel` wins; otherwise the result is `capture`. A policy without the hook
 * allows. Throws PaymentPolicyUnavailableError on a hook failure (the capture must then not be issued).
 */
export async function runBeforeCapture(tx: Tx, input: BeforeCaptureInput): Promise<BeforeCaptureResult> {
  await assertHeld(tx, input.held);
  for (const policy of policies) {
    if (!policy.beforeCapture) continue;
    const result = await inSavepoint(tx, policy.id, () => policy.beforeCapture!(tx, input));
    if (result.action === 'cancel') return result;
  }
  return { action: 'capture' };
}

/**
 * Entry point for payment paths: loads the order's reservations under the held lock set and runs
 * every policy. Call it inside the preparation transaction, after the order row is locked and
 * before any replay lookup, attempt insert, session or intent creation.
 */
export async function checkPaymentAttempt(tx: Tx, held: HeldLocks, a: {
  provider: PaymentProvider; purpose: PaymentPurpose; order: PolicyOrder;
}): Promise<void> {
  const reservations = await tx.select().from(s.orderReservation)
    .where(and(eq(s.orderReservation.storeId, a.order.storeId), eq(s.orderReservation.orderId, a.order.id)));
  await runBeforePaymentAttempt(tx, {
    provider: a.provider, purpose: a.purpose, order: a.order, reservations, held,
  });
}
