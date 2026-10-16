/**
 * Provider observation on payment_attempt (de-fork plan 2.9; migration 0088).
 *
 * `provider_status` is the provider's OWN status string for the attempt and
 * `provider_observed_at` is when we last obtained it. The pair is advanced
 * ONLY by a successful provider retrieval whose result is bound to this
 * attempt (Stripe PaymentIntent retrieve/cancel response, NMI query.php
 * transaction, Sezzle GET order). It is never written from webhook payloads
 * (they can be reordered/stale), from a failed or unavailable fetch (the
 * previous observation must stay so a stale value is visible as stale), or
 * from a response whose identity does not match the attempt.
 *
 * The health gate treats a failed attempt as unresolved when the status is
 * nonterminal (see the *_TERMINAL sets), NULL/unknown, or older than twice
 * the reconcile interval.
 */
import { and, eq, isNull, lte, or } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { withSavepoint } from '../db/savepoint.js';
import * as s from '../db/schema.js';
import { err as logErr } from '../lib/logger.js';

/**
 * Vocabulary: MAINTENANCE-INVENTORY.md 4.6 is normative. Stripe stores the raw
 * PaymentIntent status; NMI and Sezzle store the normalised labels below
 * (`unresolved:<reason>` is always nonterminal). Pinned by a unit test.
 */
export const TERMINAL_PROVIDER_STATUSES = {
  'stripe/intent': ['succeeded', 'canceled'],
  'nmi/charge': ['settled', 'failed'],
  'sezzle/session': ['captured', 'declined'],
} as const;

export interface ProviderObservation {
  status: string;
  /** Defaults to now. Callers pass the instant the retrieval returned. */
  observedAt?: Date;
}

type AttemptKey = { attemptId: string } | { storeId: string; method: string; operation: string; providerRef: string };

/**
 * Advance the observation inside the caller's transaction. Monotonic: an
 * observation older than the stored one (a slow retrieval finishing late)
 * never moves the pair backwards. Returns whether a row was advanced.
 */
export async function recordProviderObservation(tx: Tx, key: AttemptKey, obs: ProviderObservation): Promise<boolean> {
  const at = obs.observedAt ?? new Date();
  const where = 'attemptId' in key
    ? eq(s.paymentAttempt.id, key.attemptId)
    : and(
        eq(s.paymentAttempt.storeId, key.storeId), eq(s.paymentAttempt.method, key.method),
        eq(s.paymentAttempt.operation, key.operation), eq(s.paymentAttempt.providerRef, key.providerRef),
      );
  const rows = await tx.update(s.paymentAttempt)
    .set({ providerStatus: obs.status, providerObservedAt: at })
    .where(and(where, or(isNull(s.paymentAttempt.providerObservedAt), lte(s.paymentAttempt.providerObservedAt, at))))
    .returning({ id: s.paymentAttempt.id });
  return rows.length > 0;
}

/**
 * Same, in its own short transaction (retrievals run with no transaction
 * open). Instrumentation must never change a payment outcome, so a write
 * failure is logged and swallowed (the previous observation then simply stays
 * and ages, which the health gate reads as stale).
 */
export async function recordProviderObservationDetached(storeId: string, key: AttemptKey, obs: ProviderObservation): Promise<boolean> {
  try {
    return await withStore(storeId, (tx) => recordProviderObservation(tx, key, obs));
  } catch (e) {
    logErr.error('provider observation write failed', e, { status: obs.status });
    return false;
  }
}

/** Same, for a caller that is inside a customer-affecting transaction: runs in
 *  a savepoint and swallows failure so instrumentation cannot roll the work back. */
export async function recordProviderObservationSafe(tx: Tx, key: AttemptKey, obs: ProviderObservation): Promise<void> {
  try {
    await withSavepoint(tx, () => recordProviderObservation(tx, key, obs));
  } catch (e) {
    logErr.error('provider observation write failed (savepoint rolled back)', e, { status: obs.status });
  }
}
