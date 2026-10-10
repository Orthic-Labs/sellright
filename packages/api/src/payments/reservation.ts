// Order reservation lifecycle (de-fork plan 3.3; PAYMENT-TIMING.md §3.2–§3.4, §3.7).
//
// Every mutator takes the transaction under a lock set (`HeldLocks`, minted only by
// withLockedSet in db/locks.ts) so the order row (L3) and its reservation rows (L4) are
// already locked when a transition runs. This module is not wired into any payment path
// yet; steps 4–6 call it.
//
// Transitions (PAYMENT-TIMING §3.3):
//   R1 reserve        ∅ -> held
//   R2 consume        held -> consumed          (order is Paid|PartiallyRefunded; I3)
//   R3 requestRelease held (+release_requested_at)
//   R4 settleRelease  held -> released          (order Cancelled|Refunded AND providerQuiescent)
//   R5 releaseOnFullRefund consumed -> released (order Refunded, release_on_full_refund)
// R6 (operator override, released_unverified) is an admin-route concern and is not here.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { withLockedSetInTx, type HeldLocks } from '../db/locks.js';
import * as s from '../db/schema.js';
import { dispatchReservationTransitions } from './policy/transitions.js';
import { PaymentPolicyUnavailableError } from './policy/registry.js';
import { err as logErr } from '../lib/logger.js';

export type ReservationRow = typeof s.orderReservation.$inferSelect;
export type ReservationState = 'held' | 'consumed' | 'released';

/** A reservation the caller may not place: the thing is held by another live order, or this order released it. */
export class ReservationConflict extends Error {
  constructor(readonly reason: 'live_owner' | 'released' | 'order_terminal', readonly detail: string) {
    super(`order reservation conflict: ${reason} (${detail})`);
    this.name = 'ReservationConflict';
  }
}

/** A reservation rule that the caller's input violates (e.g. a fixed expiry on a provider-bound order). */
export class ReservationRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReservationRuleError';
  }
}

const PROVIDER_METHODS = ['nmi', 'stripe', 'sezzle'] as const;
const TERMINAL_RELEASE_STATES = ['Cancelled', 'Refunded'] as const;
const CONSUMABLE_STATES = ['Paid', 'PartiallyRefunded'] as const;

async function orderState(tx: Tx, storeId: string, orderId: string): Promise<string> {
  const [row] = await tx
    .select({ state: s.order.state })
    .from(s.order)
    .where(and(eq(s.order.id, orderId), eq(s.order.storeId, storeId)))
    .limit(1);
  if (!row) throw new ReservationRuleError(`order ${orderId} not found in store ${storeId}`);
  return row.state;
}

/**
 * Provider quiescence (PAYMENT-TIMING §3.4): true iff no provider work for the order can
 * still move money. Must be evaluated under the order lock. `stripeDiscoverable` is the
 * caller's pre-transaction evaluation of stripeDiscoverable(storeId, config) (no I/O here).
 */
export async function providerQuiescent(
  tx: Tx,
  storeId: string,
  orderId: string,
  opts: { stripeDiscoverable: boolean },
): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT
      NOT EXISTS (
        SELECT 1 FROM payment_attempt pa
         WHERE pa.store_id = ${storeId} AND pa.order_id = ${orderId}
           AND pa.operation <> 'refund'
           AND pa.status NOT IN ('settled', 'cancelled')
           AND NOT (pa.status = 'failed' AND (pa.method = 'nmi'
                OR (pa.method = 'sezzle' AND coalesce((pa.context->'recovery'->>'authorization_released')::boolean, false))))
      ) AND NOT EXISTS (
        SELECT 1 FROM payment p
         WHERE p.store_id = ${storeId} AND p.order_id = ${orderId} AND p.state IN ('Pending', 'Authorized')
      ) AND NOT (
        ${opts.stripeDiscoverable}::boolean AND EXISTS (
          SELECT 1 FROM "order" o
           WHERE o.id = ${orderId} AND o.store_id = ${storeId}
             AND ( coalesce((o.metadata->'stripeDiscovery'->>'hold')::boolean, false)
                OR ( NOT EXISTS (SELECT 1 FROM payment_attempt pi
                                  WHERE pi.order_id = o.id AND pi.store_id = o.store_id AND pi.operation = 'intent')
                     AND (o.metadata->'stripeDiscovery'->>'checkedAt') IS NULL ) )
        )
      ) AS quiescent`);
  return Boolean((rows as { quiescent: boolean }[])[0]?.quiescent);
}

/** R1: place a hold. Idempotent for the same order/kind/owner while held or consumed. */
export async function reserve(
  tx: Tx,
  _held: HeldLocks,
  input: {
    storeId: string;
    orderId: string;
    kind: string;
    ownerKey: string;
    holder?: Record<string, unknown>;
    releaseOnFullRefund?: boolean;
    expiresAt?: Date | null;
  },
): Promise<ReservationRow> {
  const { storeId, orderId, kind, ownerKey } = input;
  const state = await orderState(tx, storeId, orderId);
  if (state === 'Cancelled' || state === 'Refunded') {
    throw new ReservationConflict('order_terminal', `order is ${state}`);
  }

  if (input.expiresAt) {
    const [exposure] = await tx
      .select({ id: s.paymentAttempt.id })
      .from(s.paymentAttempt)
      .where(and(eq(s.paymentAttempt.storeId, storeId), eq(s.paymentAttempt.orderId, orderId),
        inArray(s.paymentAttempt.method, [...PROVIDER_METHODS])))
      .limit(1);
    if (exposure) {
      // Provider-bound money has no local deadline (PAYMENT-TIMING §3.3): a fixed expiry is only
      // for providers with a real provider-side expiry, and none is registered yet.
      throw new ReservationRuleError('expires_at must be NULL: provider-bound holds have no fixed expiry');
    }
  }

  const [existing] = await tx
    .select()
    .from(s.orderReservation)
    .where(and(eq(s.orderReservation.storeId, storeId), eq(s.orderReservation.orderId, orderId),
      eq(s.orderReservation.kind, kind), eq(s.orderReservation.ownerKey, ownerKey)))
    .limit(1);
  if (existing) {
    if (existing.state === 'released') throw new ReservationConflict('released', `${kind}:${ownerKey}`);
    return existing;
  }

  const [other] = await tx
    .select({ orderId: s.orderReservation.orderId })
    .from(s.orderReservation)
    .where(and(eq(s.orderReservation.storeId, storeId), eq(s.orderReservation.kind, kind),
      eq(s.orderReservation.ownerKey, ownerKey), inArray(s.orderReservation.state, ['held', 'consumed'])))
    .limit(1);
  if (other) throw new ReservationConflict('live_owner', `${kind}:${ownerKey} held by order ${other.orderId}`);

  const [row] = await tx
    .insert(s.orderReservation)
    .values({
      storeId,
      orderId,
      kind,
      ownerKey,
      holder: input.holder ?? {},
      releaseOnFullRefund: input.releaseOnFullRefund ?? false,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  await dispatchReservationTransitions(tx, [row!], null, 'held', 'reserved');
  return row!;
}

/**
 * R2 core: held -> consumed for the order's held rows. Locks the order row (L3) then its held rows
 * (L4), the global order. Caller guarantees the order is Paid|PartiallyRefunded (I3).
 */
async function consumeCore(
  tx: Tx,
  input: { storeId: string; orderId: string; paymentId: string | null; operationId: string },
  opts: { isolateProjection?: boolean } = {},
): Promise<ReservationRow[]> {
  const state = await orderState(tx, input.storeId, input.orderId);
  if (!(CONSUMABLE_STATES as readonly string[]).includes(state)) {
    throw new ReservationRuleError(`cannot consume reservations of a ${state} order (I3: consume implies Paid)`);
  }
  const consumed = await tx
    .update(s.orderReservation)
    .set({
      state: 'consumed',
      consumedAt: sql`now()`,
      providerTerminalAt: sql`now()`,
      consumedPaymentId: input.paymentId,
      consumedOperationId: input.operationId,
      updatedAt: sql`now()`,
    })
    .where(and(eq(s.orderReservation.storeId, input.storeId), eq(s.orderReservation.orderId, input.orderId),
      eq(s.orderReservation.state, 'held')))
    .returning();
  if (!opts.isolateProjection) {
    await dispatchReservationTransitions(tx, consumed, 'held', 'consumed', 'consumed');
    return consumed;
  }
  // Settlement records money the provider already moved (X-45): it must commit. R2 leaves the rollback
  // projection unchanged (§3.3), so a failing projection is rolled back to its own savepoint (inSavepoint),
  // logged and audited, and the settlement proceeds.
  try {
    await dispatchReservationTransitions(tx, consumed, 'held', 'consumed', 'consumed');
  } catch (e) {
    if (!(e instanceof PaymentPolicyUnavailableError)) throw e;
    logErr.error('reservation consume projection failed; settlement continues', e, { orderId: input.orderId, operationId: input.operationId });
    await tx.insert(s.auditLog).values({
      storeId: input.storeId, actor: 'system:policy', entity: 'order', entityId: input.orderId,
      action: 'reservation_projection_failed',
      data: { cause: 'consumed', operationId: input.operationId, reservationIds: consumed.map((r) => r.id) },
    });
  }
  return consumed;
}

/**
 * R2: consume the order's held reservations because the order became Paid in this tx.
 * Released rows are never consumed (I1). Returns the rows this call consumed (empty on replay).
 */
export async function consume(
  tx: Tx,
  _held: HeldLocks,
  input: { storeId: string; orderId: string; paymentId: string; operationId: string },
): Promise<ReservationRow[]> {
  return consumeCore(tx, input);
}

/**
 * R2 at the settlement chokepoint (PAYMENT-TIMING §3.7): called by recordSettlementOperation inside the
 * settlement transaction, so consumption commits or rolls back with the payment row and the Paid
 * transition. The chokepoint cannot mint HeldLocks, so this takes the order row (L3) and the held rows
 * (L4) itself, in the global order. Returns [] (no-op) unless the order is Paid|PartiallyRefunded and
 * holds live held rows, so orders without reservations are untouched.
 */
export async function consumeForSettlement(
  tx: Tx,
  input: { storeId: string; orderId: string; paymentId: string | null; operationId: string },
): Promise<ReservationRow[]> {
  // Fast path (no locks): an order without held rows is untouched by the settlement.
  const [any] = await tx.select({ id: s.orderReservation.id }).from(s.orderReservation).where(and(
    eq(s.orderReservation.storeId, input.storeId), eq(s.orderReservation.orderId, input.orderId),
    eq(s.orderReservation.state, 'held'))).limit(1);
  if (!any) return [];
  const [o] = await tx.select({ state: s.order.state }).from(s.order)
    .where(and(eq(s.order.id, input.orderId), eq(s.order.storeId, input.storeId))).limit(1).for('update');
  if (!o || !(CONSUMABLE_STATES as readonly string[]).includes(o.state)) return [];
  return consumeCore(tx, input, { isolateProjection: true });
}

/** R3: a cancel path asked to release. Records the request; effective only through settleRelease. */
export async function requestRelease(
  tx: Tx,
  _held: HeldLocks,
  input: { storeId: string; orderId: string; reason: string },
): Promise<ReservationRow[]> {
  return tx
    .update(s.orderReservation)
    .set({
      releaseRequestedAt: sql`coalesce(${s.orderReservation.releaseRequestedAt}, now())`,
      releaseReason: sql`coalesce(${s.orderReservation.releaseReason}, ${input.reason})`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(s.orderReservation.storeId, input.storeId), eq(s.orderReservation.orderId, input.orderId),
      eq(s.orderReservation.state, 'held')))
    .returning();
}

/**
 * R4: release requested held rows once the order is terminal and provider work is quiescent.
 * Safe to call repeatedly (sweeps, a terminal provider event): a no-op until both hold.
 * Returns the rows released by this call.
 */
export async function settleRelease(
  tx: Tx,
  _held: HeldLocks,
  input: { storeId: string; orderId: string; stripeDiscoverable: boolean },
): Promise<ReservationRow[]> {
  return settleReleaseCore(tx, input);
}

async function settleReleaseCore(
  tx: Tx,
  input: { storeId: string; orderId: string; stripeDiscoverable: boolean },
): Promise<ReservationRow[]> {
  const state = await orderState(tx, input.storeId, input.orderId);
  if (!(TERMINAL_RELEASE_STATES as readonly string[]).includes(state)) return [];
  const pending = await tx
    .select({ id: s.orderReservation.id })
    .from(s.orderReservation)
    .where(and(eq(s.orderReservation.storeId, input.storeId), eq(s.orderReservation.orderId, input.orderId),
      eq(s.orderReservation.state, 'held'), sql`${s.orderReservation.releaseRequestedAt} is not null`));
  if (!pending.length) return [];
  const quiescent = await providerQuiescent(tx, input.storeId, input.orderId, {
    stripeDiscoverable: input.stripeDiscoverable,
  });
  if (!quiescent) return [];
  const released = await tx
    .update(s.orderReservation)
    .set({ state: 'released', releasedAt: sql`now()`, providerTerminalAt: sql`now()`, updatedAt: sql`now()` })
    .where(inArray(s.orderReservation.id, pending.map((r) => r.id)))
    .returning();
  await dispatchReservationTransitions(tx, released, 'held', 'released', state === 'Refunded' ? 'order_refunded' : 'order_cancelled');
  return released;
}

/** R3 + R4 in one call: the cancel path's entry point. Returns the rows still held with a request. */
export async function release(
  tx: Tx,
  held: HeldLocks,
  input: { storeId: string; orderId: string; reason: string; stripeDiscoverable: boolean },
): Promise<{ released: ReservationRow[]; pending: ReservationRow[] }> {
  await requestRelease(tx, held, { storeId: input.storeId, orderId: input.orderId, reason: input.reason });
  const released = await settleRelease(tx, held, input);
  const pending = await tx
    .select()
    .from(s.orderReservation)
    .where(and(eq(s.orderReservation.storeId, input.storeId), eq(s.orderReservation.orderId, input.orderId),
      eq(s.orderReservation.state, 'held')));
  return { released, pending };
}

/** True when the order holds a held reservation with a release request (cheap, no locks). */
export async function hasPendingRelease(storeId: string, orderId: string): Promise<boolean> {
  return withStore(storeId, async (tx) => {
    const [row] = await tx.select({ id: s.orderReservation.id }).from(s.orderReservation).where(and(
      eq(s.orderReservation.storeId, storeId), eq(s.orderReservation.orderId, orderId),
      eq(s.orderReservation.state, 'held'), sql`${s.orderReservation.releaseRequestedAt} is not null`)).limit(1);
    return !!row;
  });
}

/**
 * R4 at a provider-terminal observation (PAYMENT-TIMING §5.2): a confirmed Stripe cancellation, observed
 * by the webhook, a reconcile or a sweep, releases the order's requested holds in the SAME transaction,
 * after the attempt has been written `cancelled`. Takes the order row (L3) then the held rows (L4), the
 * global order. No-op unless a release was requested and the order is Cancelled|Refunded and quiescent.
 * `stripeDiscoverable: true` is the conservative value (clause 3 applies): an unknown Stripe side holds.
 */
export async function releaseOnProviderTerminal(tx: Tx, input: { storeId: string; orderId: string }): Promise<ReservationRow[]> {
  const [any] = await tx.select({ id: s.orderReservation.id }).from(s.orderReservation).where(and(
    eq(s.orderReservation.storeId, input.storeId), eq(s.orderReservation.orderId, input.orderId),
    eq(s.orderReservation.state, 'held'), sql`${s.orderReservation.releaseRequestedAt} is not null`)).limit(1);
  if (!any) return [];
  await tx.select({ id: s.order.id }).from(s.order)
    .where(and(eq(s.order.id, input.orderId), eq(s.order.storeId, input.storeId))).limit(1).for('update');
  return settleReleaseCore(tx, { storeId: input.storeId, orderId: input.orderId, stripeDiscoverable: true });
}

/** Standalone form of releaseOnProviderTerminal for callers that hold no transaction. */
export async function settleOrderReleases(storeId: string, orderId: string): Promise<ReservationRow[]> {
  return withStore(storeId, (tx) => releaseOnProviderTerminal(tx, { storeId, orderId }));
}

/** R5: a full refund releases consumed holds that asked for it. Requires the order to be Refunded. */
export async function releaseOnFullRefund(
  tx: Tx,
  _held: HeldLocks,
  input: { storeId: string; orderId: string },
): Promise<ReservationRow[]> {
  const state = await orderState(tx, input.storeId, input.orderId);
  if (state !== 'Refunded') return [];
  const released = await tx
    .update(s.orderReservation)
    .set({ state: 'released', releasedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(s.orderReservation.storeId, input.storeId), eq(s.orderReservation.orderId, input.orderId),
      eq(s.orderReservation.state, 'consumed'), eq(s.orderReservation.releaseOnFullRefund, true)))
    .returning();
  await dispatchReservationTransitions(tx, released, 'consumed', 'released', 'order_refunded');
  return released;
}

/**
 * R5 at a refund that moved the order to Refunded (X-45): the refund records money the provider already
 * moved, so a failing projection must NOT abort it. The release runs in its own savepoint; a
 * PaymentPolicyUnavailableError rolls the release back, keeps the rows `consumed`, marks them with
 * release_requested_at (so the reservation-release sweep retries), and audits the failure with an admin
 * task. Other errors still abort the caller's transaction.
 */
export async function releaseOnFullRefundOrDefer(
  tx: Tx,
  held: HeldLocks,
  input: { storeId: string; orderId: string; refundId?: string | null },
): Promise<{ released: ReservationRow[]; deferred: boolean }> {
  await tx.execute(sql`SAVEPOINT reservation_r5`);
  try {
    const released = await releaseOnFullRefund(tx, held, input);
    await tx.execute(sql`RELEASE SAVEPOINT reservation_r5`);
    return { released, deferred: false };
  } catch (e) {
    await tx.execute(sql`ROLLBACK TO SAVEPOINT reservation_r5`);
    await tx.execute(sql`RELEASE SAVEPOINT reservation_r5`);
    if (!(e instanceof PaymentPolicyUnavailableError)) throw e;
    const deferred = await tx.update(s.orderReservation)
      .set({
        releaseRequestedAt: sql`coalesce(${s.orderReservation.releaseRequestedAt}, now())`,
        releaseReason: sql`coalesce(${s.orderReservation.releaseReason}, 'order_refunded')`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(s.orderReservation.storeId, input.storeId), eq(s.orderReservation.orderId, input.orderId),
        eq(s.orderReservation.state, 'consumed'), eq(s.orderReservation.releaseOnFullRefund, true)))
      .returning({ id: s.orderReservation.id });
    if (deferred.length) {
      const detail = `release of ${deferred.length} reservation(s) deferred after a refund: projection unavailable; the sweep retries`;
      await tx.insert(s.auditLog).values({
        storeId: input.storeId, actor: 'system:policy', entity: 'order', entityId: input.orderId,
        action: 'reservation_projection_failed',
        data: { cause: 'order_refunded', refundId: input.refundId ?? null, reservationIds: deferred.map((r) => r.id) },
      });
      await tx.insert(s.auditLog).values({
        storeId: input.storeId, actor: 'system:policy', entity: 'order', entityId: input.orderId,
        action: 'policy_admin_task',
        data: { title: 'Reservation release pending after refund', detail, code: 'reservation_projection_failed' },
      });
    }
    return { released: [], deferred: true };
  }
}

/**
 * R5 for a refund path whose transaction already runs under the order's lock set (finalizeRefund's contract,
 * the webhook and sezzle reconcilers): passes through that set, or takes it for this transaction.
 */
export async function releaseOnFullRefundInSet(
  tx: Tx,
  input: { storeId: string; orderId: string; refundId?: string | null },
): Promise<{ released: ReservationRow[]; deferred: boolean }> {
  return withLockedSetInTx(tx, input.storeId, { kind: 'order', orderId: input.orderId }, (t, held) => releaseOnFullRefundOrDefer(t, held, input));
}

/**
 * R6 (PAYMENT-TIMING §5.3.3): operator override. Releases the order's held rows while provider state is
 * unverified. Requires a Cancelled order and a reason of at least 10 characters. Money that lands later
 * follows I1 (recorded, payment_after_cancel).
 */
export async function overrideRelease(
  tx: Tx,
  _held: HeldLocks,
  input: { storeId: string; orderId: string; reason: string },
): Promise<ReservationRow[]> {
  if (input.reason.trim().length < 10) throw new ReservationRuleError('override reason must be at least 10 characters');
  const state = await orderState(tx, input.storeId, input.orderId);
  if (state !== 'Cancelled') throw new ReservationRuleError(`operator override requires a Cancelled order (order is ${state})`);
  const released = await tx
    .update(s.orderReservation)
    .set({
      state: 'released', releasedAt: sql`now()`, providerTerminalAt: sql`now()`, releasedUnverified: true,
      releaseReason: `operator_override: ${input.reason.trim()}`, updatedAt: sql`now()`,
    })
    .where(and(eq(s.orderReservation.storeId, input.storeId), eq(s.orderReservation.orderId, input.orderId),
      eq(s.orderReservation.state, 'held')))
    .returning();
  await dispatchReservationTransitions(tx, released, 'held', 'released', 'operator_override');
  return released;
}

/**
 * Purge gate (PAYMENT-TIMING §3.5, R2-1): true when the order holds a held reservation whose provider work
 * could still move money. The caller refuses the purge in that case. Evaluated under the order lock.
 * `stripeDiscoverable` is the caller's pre-transaction stripeDiscoverable(storeId, config) (no I/O here).
 */
export async function purgeBlockedByReservations(
  tx: Tx,
  storeId: string,
  orderId: string,
  opts: { stripeDiscoverable: boolean },
): Promise<boolean> {
  const [held] = await tx.select({ id: s.orderReservation.id }).from(s.orderReservation).where(and(
    eq(s.orderReservation.storeId, storeId), eq(s.orderReservation.orderId, orderId),
    eq(s.orderReservation.state, 'held'))).limit(1);
  if (!held) return false;
  return !(await providerQuiescent(tx, storeId, orderId, { stripeDiscoverable: opts.stripeDiscoverable }));
}

/**
 * Purge (PAYMENT-TIMING §3.5): every reservation of the order is projected as released (cause order_purged)
 * and deleted, before the order row (FK). Runs under the order's lock set (the caller holds HeldLocks).
 */
export async function purgeReservations(
  tx: Tx,
  _held: HeldLocks,
  input: { storeId: string; orderId: string },
): Promise<ReservationRow[]> {
  const rows = await tx.select().from(s.orderReservation).where(and(
    eq(s.orderReservation.storeId, input.storeId), eq(s.orderReservation.orderId, input.orderId)));
  for (const row of rows) {
    await dispatchReservationTransitions(tx, [{ ...row, state: 'released' }], row.state, 'released', 'order_purged');
  }
  if (rows.length) {
    await tx.delete(s.orderReservation).where(and(
      eq(s.orderReservation.storeId, input.storeId), eq(s.orderReservation.orderId, input.orderId)));
  }
  return rows;
}

/** Live (held or consumed) reservations, optionally narrowed. Read-only; no lock brand needed. */
export async function findOpen(
  tx: Tx,
  filter: { storeId: string; orderId?: string; kind?: string; ownerKey?: string },
): Promise<ReservationRow[]> {
  const conds = [
    eq(s.orderReservation.storeId, filter.storeId),
    inArray(s.orderReservation.state, ['held', 'consumed']),
  ];
  if (filter.orderId) conds.push(eq(s.orderReservation.orderId, filter.orderId));
  if (filter.kind) conds.push(eq(s.orderReservation.kind, filter.kind));
  if (filter.ownerKey) conds.push(eq(s.orderReservation.ownerKey, filter.ownerKey));
  return tx.select().from(s.orderReservation).where(and(...conds));
}
