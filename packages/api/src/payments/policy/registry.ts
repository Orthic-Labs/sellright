// Payment policy registry and SAVEPOINT wrapper (PAYMENT-TIMING.md §3.1 composition and isolation).
//
// Kept apart from host.ts so the reservation service (payments/reservation.ts) can dispatch projection
// transitions without importing the hook runners, which in turn call the reservation service.
import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import type { PaymentPolicy, PolicyVeto } from './types.js';

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

/** Two policies asked for the same identity (kind, ownerKey) in one composition: a reservation or a licence metadata key. */
export class PaymentPolicyCompositionError extends Error {
  constructor(readonly kind: string, readonly ownerKey: string, readonly policyIds: readonly string[]) {
    super(`composition conflict on (${kind}, ${ownerKey}) requested by policies ${policyIds.join(', ')}`);
    this.name = 'PaymentPolicyCompositionError';
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

/**
 * Runs one hook inside SAVEPOINT policy_hook. A failure rolls back to the savepoint, so the outer
 * transaction stays usable, and surfaces as PaymentPolicyUnavailableError.
 */
export async function inSavepoint<T>(tx: Tx, policyId: string, fn: () => Promise<T>): Promise<T> {
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
