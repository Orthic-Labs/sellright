/**
 * Human approval of an edit_reconcile effect that was held instead of issuing (issue #192).
 *
 * The hold (handlers.ts editReconcile) is terminal: an agent-made edit, or a legacy edit whose actor cannot be resolved,
 * never issues on its own, and an ordinary retry reaches the same recorded decision. A human may explicitly approve the
 * issuance. The approval is FRESH authorisation, not a rewrite of the recorded principal: `edit_principal_resolved` and the
 * hold audit rows stay as written, the approval lands beside them (payload.issuanceApprovedBy + an `edit_issuance_approved`
 * audit row), and reconciliation honours it only for this exact effect and order.
 */
import { and, eq, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../../db/client.js';
import { LockSetUnstable, withLockedSet } from '../../db/locks.js';
import * as s from '../../db/schema.js';
import { executeEffectsNow, recordEffectIssuanceApproval, requeueTerminalEffect, resolveReviewTasksForEffect, type EffectRow } from './effects.js';

/** The terminal reasons editReconcile writes when it holds issuance for a human (and only these are approvable). */
export const HELD_ISSUANCE_REASONS = ['EDIT_PRINCIPAL_UNRESOLVED', 'AGENT_ISSUANCE_REFUSED'] as const;
export const ISSUANCE_APPROVED_ACTION = 'edit_issuance_approved';

/** Fresh human authorisation carried in the effect payload; bound to one effect and one order. */
export interface IssuanceApproval {
  adminUserId: string; email: string; at: string; effectId: string; orderId: string;
}

export class IssuanceApprovalError extends Error {
  constructor(public readonly status: 404 | 409, public readonly code: string, message: string) { super(message); }
}

export interface ApproveResult {
  effectId: string; orderId: string;
  /** true when this call recorded the approval; false when the effect already carried one (nothing issued by this call). */
  approvedNow: boolean;
  status: string;
}

/**
 * The approval an edit_reconcile run may rely on, or null. Valid only when it names THIS effect and THIS order, and a
 * matching `edit_issuance_approved` audit row exists for the effect and the same admin: a payload alone is never enough.
 */
export async function validIssuanceApproval(tx: Tx, e: EffectRow, p: { orderId: string; issuanceApprovedBy?: unknown }): Promise<IssuanceApproval | null> {
  const a = p.issuanceApprovedBy as Partial<IssuanceApproval> | null | undefined;
  if (!a || typeof a !== 'object') return null;
  if (typeof a.adminUserId !== 'string' || typeof a.email !== 'string' || typeof a.at !== 'string') return null;
  if (a.effectId !== e.id || a.orderId !== p.orderId) return null;
  const [row] = await tx.select({ id: s.auditLog.id }).from(s.auditLog).where(and(
    eq(s.auditLog.storeId, e.storeId), eq(s.auditLog.entity, 'order_pending_effect'), eq(s.auditLog.entityId, e.id),
    eq(s.auditLog.action, ISSUANCE_APPROVED_ACTION), sql`${s.auditLog.data}->>'adminUserId' = ${a.adminUserId}`,
    sql`${s.auditLog.data}->>'orderId' = ${p.orderId}`)).limit(1);
  return row ? (a as IssuanceApproval) : null;
}

/**
 * Closes the review task that announced the hold, in the transaction that marks the effect done. The task is the
 * admin_review row of the same operation naming this effect (engine markTerminal); it leaves the review queue once its
 * `resolution` is set (listEffectsNeedingAttention).
 */
export async function resolveHeldReviewTasks(tx: Tx, e: EffectRow, approval: IssuanceApproval): Promise<void> {
  await resolveReviewTasksForEffect(tx, e, {
    action: 'approved_issuance', actor: approval.email, adminUserId: approval.adminUserId, effectId: e.id, at: new Date().toISOString(),
  });
}

/**
 * Approve and run a held edit_reconcile effect. One transaction under the order's lock set: record the approval,
 * requeue, and run the effect inline, so issuance, the effect's `done` and the review task's resolution commit together
 * or not at all.
 *
 * Lock order: the worker takes the effect row FIRST, then the order set (processClaimedEffect -> editReconcile); this
 * path takes the order set first, so it must never WAIT for the effect row while holding the set (that is the
 * deadlock cycle). The effect row is taken NOWAIT: when the worker holds it, Postgres raises 55P03 at once, the
 * transaction rolls back (releasing the order set) and withLockedSet restarts it through its bounded lock-contention
 * retry. The approver never blocks, so the worker's wait for the order set always ends. When the budget runs out it is a
 * 409 EFFECT_BUSY (retry the request).
 *  - 404 EFFECT_NOT_FOUND; 409 EFFECT_NOT_HELD when it is not an edit_reconcile effect terminal on a hold.
 *  - Idempotent: an effect that already carries an approval is returned unchanged and issues nothing more.
 */
export async function approveHeldEditIssuance(storeId: string, effectId: string, approver: { adminUserId: string; email: string }): Promise<ApproveResult> {
  const peek = await peekEffect(storeId, effectId);
  if (!peek) throw new IssuanceApprovalError(404, 'EFFECT_NOT_FOUND', 'Effect not found');
  const orderId = (peek.payload as { orderId?: unknown } | null)?.orderId;
  if (peek.effectKind !== 'edit_reconcile' || typeof orderId !== 'string') {
    throw new IssuanceApprovalError(409, 'EFFECT_NOT_HELD', 'Effect is not a held order-edit issuance');
  }
  try {
    return await approveLocked(storeId, effectId, orderId, approver);
  } catch (e) {
    if (e instanceof LockSetUnstable) throw new IssuanceApprovalError(409, 'EFFECT_BUSY', 'Effect is being processed; retry the approval');
    throw e;
  }
}

async function approveLocked(storeId: string, effectId: string, orderId: string, approver: { adminUserId: string; email: string }): Promise<ApproveResult> {
  return withLockedSet(storeId, { kind: 'order', orderId }, async (tx) => {
    // NOWAIT, never a wait while holding the order set (see approveHeldEditIssuance): 55P03 restarts the whole transaction.
    const [cur] = await tx.select().from(s.orderPendingEffect)
      .where(and(eq(s.orderPendingEffect.id, effectId), eq(s.orderPendingEffect.storeId, storeId))).limit(1).for('update', { noWait: true });
    const curOrderId = (cur?.payload as { orderId?: unknown } | null)?.orderId;
    if (!cur || cur.effectKind !== 'edit_reconcile' || curOrderId !== orderId) {
      throw new IssuanceApprovalError(409, 'EFFECT_NOT_HELD', 'Effect is not a held order-edit issuance');
    }
    const payload = cur.payload as { issuanceApprovedBy?: unknown };
    if (payload.issuanceApprovedBy && cur.status !== 'terminal') {
      return { effectId, orderId, approvedNow: false, status: cur.status };
    }
    const held = cur.status === 'terminal' && (HELD_ISSUANCE_REASONS as readonly string[]).includes(cur.lastError ?? '');
    if (!held) throw new IssuanceApprovalError(409, 'EFFECT_NOT_HELD', 'Effect is not held for issuance approval');

    const approval: IssuanceApproval = { adminUserId: approver.adminUserId, email: approver.email, at: new Date().toISOString(), effectId, orderId };
    await recordEffectIssuanceApproval(tx, effectId, { ...approval });
    await tx.insert(s.auditLog).values({
      storeId, actor: approver.email, entity: 'order_pending_effect', entityId: effectId, action: ISSUANCE_APPROVED_ACTION,
      data: { adminUserId: approver.adminUserId, email: approver.email, effectId, orderId, operationId: cur.operationId, heldReason: cur.lastError },
    });
    if (!(await requeueTerminalEffect(tx, effectId))) throw new IssuanceApprovalError(409, 'EFFECT_NOT_HELD', 'Effect is not held for issuance approval');
    await executeEffectsNow(tx, [effectId]);
    const [after] = await tx.select({ status: s.orderPendingEffect.status }).from(s.orderPendingEffect).where(eq(s.orderPendingEffect.id, effectId)).limit(1);
    return { effectId, orderId, approvedNow: true, status: after?.status ?? 'unknown' };
  }, { maxRestarts: 8 });
}

/** Unlocked first read: the effect's kind and payload, to learn which order to lock. */
async function peekEffect(storeId: string, effectId: string): Promise<EffectRow | undefined> {
  return withStore(storeId, async (tx) => (await tx.select().from(s.orderPendingEffect)
    .where(and(eq(s.orderPendingEffect.id, effectId), eq(s.orderPendingEffect.storeId, storeId))).limit(1))[0]);
}
