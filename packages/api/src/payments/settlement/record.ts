/**
 * THE settlement chokepoint (de-fork plan 2.8; SETTLEMENT-OPS.md section 7).
 *
 * Every write to `payment` and `subscription_invoice_payment`, every order
 * insert/update that can produce state 'Paid', and every `settlement_operation`
 * row goes through recordSettlementOperation(). The mutation and the effect rows
 * it authorizes commit in the caller's transaction; the operation's identity is
 * the provider/business fact (ops.ts), so replaying the fact — through any path —
 * mutates nothing and creates no second effect.
 *
 * The structural CI check (scripts/assert-settlement-chokepoint.mjs) fails the
 * build on any other write to these tables outside this function and the
 * enumerated, fixture-backed allowlist.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { canTransition, type OrderState } from '../../money/fsm.js';
import { registerBuiltinEffectHandlers } from './handlers.js';
import { enqueueEffects, executeEffectsNow, type EffectMode, type EffectRequest } from './effects.js';
import {
  INVOICE_AUTHORIZED_EFFECTS, MONOTONE_KINDS, OPERATION_POLICY,
  type InvoiceClassification, type MutationType, type SettlementKind,
} from './ops.js';

registerBuiltinEffectHandlers();

export type PaymentInsert = typeof s.payment.$inferInsert;
export type OrderInsert = typeof s.order.$inferInsert;
export type SubscriptionInvoicePaymentInsert = typeof s.subscriptionInvoicePayment.$inferInsert;
export interface PaymentStateUpdate {
  state: typeof s.payment.$inferSelect.state;
  metadata?: object | null;
  errorMessage?: string | null;
}

export type SettlementMutation =
  /** single or bulk; conflict semantics = onConflictDoNothing as the old direct inserts */
  | { type: 'payment_insert'; rows: PaymentInsert[] }
  /** monotone: a Settled payment is never rewritten */
  | { type: 'payment_state'; paymentId: string; next: PaymentStateUpdate }
  /** fills NULLs only */
  | { type: 'payment_gateway_identity'; paymentId: string; gatewayMode?: string | null; gatewayAccount?: string | null }
  /** transitions through the FSM (canTransition) */
  | { type: 'order_paid'; orderId: string; placedAt: Date; updatedAt?: Date }
  /** may carry state 'Paid' (admin manual order) */
  | { type: 'order_insert'; rows: OrderInsert[] }
  /** orderless invoice money (payment.order_id is NOT NULL) */
  | { type: 'invoice_payment_record'; row: SubscriptionInvoicePaymentInsert }
  /** snapshot the order's payments onto the operation row, then delete the payment rows and the order row */
  | { type: 'order_purge'; orderId: string };

export interface SettlementOperation {
  storeId: string;
  kind: SettlementKind;
  /** The business fact id (see OPERATION_POLICY[kind].identity). */
  operationId: string;
  provider?: { account: string; mode: 'test' | 'live'; ref: string };
  /** REQUIRED iff kind is 'stripe_invoice_paid' (frozen on first observation) or 'operator_resolution' (the operator's choice). */
  classification?: InvoiceClassification;
  /** REQUIRED iff kind === 'operator_resolution'. */
  resolution?: { targetKind: SettlementKind; targetId: string; action: 'apply' | 'skip'; actor: string; reason: string };
  disposition?: string;
  /** Persisted on the operation row (linkage that survives delayed issuance). */
  orderId?: string;
  mutations: readonly SettlementMutation[];
  effects: readonly EffectRequest[];
  /**
   * inline (default): the recorded effects run in this transaction before it
   * commits (identical observable behaviour to the old direct calls).
   * deferred: left `pending` for the worker; the caller may run them later in the
   * same transaction with executeEffectsNow().
   */
  effectMode?: EffectMode;
}

export interface SettlementResult {
  /** This call recorded the operation (false on a replay or a payment conflict). */
  created: boolean;
  /** The operation fact was already recorded: nothing was mutated and no effect row was created. */
  replayed: boolean;
  operationRowId: string | null;
  paymentId?: string;
  invoicePaymentId?: string;
  /** Effect rows created by this call (on a replay: the existing ones). */
  effectIds: string[];
  storedClassification?: InvoiceClassification;
}

/** Operation kinds whose operationId IS the id of the payment row the operation inserts. */
const PAYMENT_IDENTITY_KINDS: ReadonlySet<SettlementKind> = new Set<SettlementKind>(['payment_settled', 'duplicate_capture_recorded']);

export async function recordSettlementOperation(tx: Tx, op: SettlementOperation): Promise<SettlementResult> {
  const policy = OPERATION_POLICY[op.kind];
  if (!policy) throw new Error(`unknown settlement operation kind "${op.kind}"`);

  // 1. store scope: this function writes tenant tables on the caller's transaction.
  const scope = await tx.execute(sql`SELECT nullif(current_setting('app.current_store', true), '') AS store`);
  if ((scope.rows[0] as { store: string | null } | undefined)?.store !== op.storeId) {
    throw new Error('recordSettlementOperation requires a transaction scoped to the operation store');
  }

  // 2. eligibility (also enforced by the AST rule S7 for literal calls)
  const allowedMutations: readonly MutationType[] = policy.mutations;
  for (const m of op.mutations) {
    if (!allowedMutations.includes(m.type)) throw new Error(`settlement operation "${op.kind}" may not perform mutation "${m.type}"`);
  }
  let authorized: readonly string[] = policy.effects;
  if (op.kind === 'stripe_invoice_paid') {
    if (!op.classification) throw new Error('settlement operation "stripe_invoice_paid" requires a classification');
    authorized = INVOICE_AUTHORIZED_EFFECTS[op.classification];
  }
  if ((op.kind === 'operator_resolution') !== (op.resolution != null)) throw new Error('settlement operation "operator_resolution" requires (only it takes) a resolution');
  if (op.kind === 'operator_resolution') {
    if (!op.classification) throw new Error('settlement operation "operator_resolution" requires a classification');
    // intersected with what the operator's chosen classification authorizes; `skip` authorizes nothing
    authorized = op.resolution!.action === 'skip' ? [] : INVOICE_AUTHORIZED_EFFECTS[op.classification].filter((k) => k !== 'admin_review');
    if (op.resolution!.action === 'skip' && (op.mutations.length || op.effects.length)) throw new Error('a skipped resolution records the decision only');
  }
  for (const e of op.effects) {
    if (!(policy.effects as readonly string[]).includes(e.kind)) throw new Error(`settlement operation "${op.kind}" is not eligible for effect "${e.kind}"`);
    if (!authorized.includes(e.kind)) throw new Error(`effect "${e.kind}" is not authorized for classification "${op.classification}"`);
  }

  // 3. resolve the identity first. A ref-bearing payment is keyed by its PROVIDER REF: lock the ref,
  //    insert-or-select the payment row, and the payment id becomes the operation id before the
  //    operation row exists (two first observations of one ref resolve to one payment and one operation).
  let operationId = op.operationId;
  let preResolved: string | null = null;
  const refInsert = op.kind === 'payment_settled' || op.kind === 'payment_state_progress'
    ? op.mutations.find((m): m is Extract<SettlementMutation, { type: 'payment_insert' }> => m.type === 'payment_insert' && m.rows.length === 1 && !!m.rows[0]!.providerRef)
    : undefined;
  if (refInsert) {
    const row = refInsert.rows[0]!;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'settle:' + op.storeId + ':payref:' + row.method + ':' + row.providerRef}, 0))`);
    const ins = await tx.insert(s.payment).values(row).onConflictDoNothing().returning({ id: s.payment.id });
    if (ins[0]) preResolved = ins[0].id;
    else {
      const [ex] = await tx.select({ id: s.payment.id }).from(s.payment).where(and(
        eq(s.payment.storeId, op.storeId), eq(s.payment.method, row.method), eq(s.payment.providerRef, row.providerRef!))).limit(1).for('update');
      if (!ex) throw new Error('Payment reference does not match the order and amount');
      preResolved = ex.id;
    }
    if (op.kind === 'payment_settled') operationId = preResolved;
  } else {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'settle:' + op.storeId + ':' + op.kind + ':' + op.operationId}, 0))`);
  }
  const apply = async (): Promise<{ paymentId?: string; invoicePaymentId?: string; orderId?: string }> => {
    const out: { paymentId?: string; invoicePaymentId?: string; orderId?: string } = {};
    for (const m of op.mutations) {
      switch (m.type) {
        case 'payment_insert': {
          if (preResolved && m === refInsert) { out.paymentId ??= preResolved; break; }
          const rows = await tx.insert(s.payment).values(m.rows).onConflictDoNothing().returning({ id: s.payment.id });
          if (rows[0] && out.paymentId === undefined) out.paymentId = rows[0].id;
          else if (!rows[0] && m.rows.length === 1 && op.kind === 'stripe_invoice_paid' && op.classification === 'first_cycle') {
            // main applyPaymentResult: a first-cycle Settled invoice payment adopts the Pending row already holding
            // its providerRef (same order, not yet Settled) instead of leaving it Pending. Same columns as main's update.
            const row = m.rows[0]!;
            const [ex] = await tx.select({ id: s.payment.id, orderId: s.payment.orderId, state: s.payment.state }).from(s.payment).where(and(
              eq(s.payment.storeId, op.storeId), eq(s.payment.method, row.method), eq(s.payment.providerRef, row.providerRef!))).limit(1).for('update');
            if (ex && ex.orderId === row.orderId && ex.state === 'Pending' && row.state === 'Settled') {
              await tx.update(s.payment).set({ state: 'Settled', metadata: row.metadata ?? null, errorMessage: null }).where(eq(s.payment.id, ex.id));
              out.paymentId ??= ex.id;
            }
          }
          break;
        }
        case 'payment_state':
          // never downgrade captured funds
          await tx.update(s.payment).set({ state: m.next.state, metadata: m.next.metadata, errorMessage: m.next.errorMessage })
            .where(and(eq(s.payment.id, m.paymentId), ne(s.payment.state, 'Settled')));
          out.paymentId ??= m.paymentId;
          break;
        case 'payment_gateway_identity':
          await tx.update(s.payment).set({
            gatewayMode: sql`coalesce(${s.payment.gatewayMode}, ${m.gatewayMode ?? null})`,
            gatewayAccount: sql`coalesce(${s.payment.gatewayAccount}, ${m.gatewayAccount ?? null})`,
          }).where(eq(s.payment.id, m.paymentId));
          out.paymentId ??= m.paymentId;
          break;
        case 'order_paid': {
          const [cur] = await tx.select({ state: s.order.state }).from(s.order)
            .where(and(eq(s.order.id, m.orderId), eq(s.order.storeId, op.storeId))).limit(1).for('update');
          if (!cur) throw new Error('settlement order is missing');
          if (!canTransition(cur.state as OrderState, 'Paid')) throw new Error(`order cannot transition ${cur.state} -> Paid`);
          await tx.update(s.order).set({ state: 'Paid', placedAt: m.placedAt, updatedAt: m.updatedAt ?? new Date() })
            .where(eq(s.order.id, m.orderId));
          out.orderId = m.orderId;
          break;
        }
        case 'order_insert':
          await tx.insert(s.order).values(m.rows);
          if (m.rows[0]?.id) out.orderId ??= m.rows[0].id;
          break;
        case 'order_purge': {
          // F7: effects still pending for this order can never run against a deleted order. Cancel them
          // here (status done, result.cancelled) so they do not go terminal and raise admin_review /
          // effect.terminal for a deliberate purge. Linkage: the payload's orderId, or an operation
          // persisted with this order_id. Claimed rows (processing) are left to their fenced owner.
          await tx.execute(sql`UPDATE order_pending_effect SET status = 'done',
              result = jsonb_build_object('cancelled', 'order_purged', 'orderId', ${m.orderId}::text), updated_at = now()
            WHERE store_id = ${op.storeId} AND status = 'pending'
              AND ((payload->>'orderId') = ${m.orderId}::text
                OR (operation_kind, operation_id) IN (SELECT operation_kind, operation_id FROM settlement_operation
                    WHERE store_id = ${op.storeId} AND order_id = ${m.orderId}::uuid))`);
          await tx.delete(s.payment).where(and(eq(s.payment.storeId, op.storeId), eq(s.payment.orderId, m.orderId)));
          await tx.delete(s.order).where(and(eq(s.order.storeId, op.storeId), eq(s.order.id, m.orderId)));
          out.orderId = m.orderId;
          break;
        }
        case 'invoice_payment_record': {
          // cross-table uniqueness cannot be an index: refuse when a payment row already carries this reference
          const [dupe] = await tx.select({ id: s.payment.id }).from(s.payment)
            .where(and(eq(s.payment.storeId, op.storeId), eq(s.payment.providerRef, m.row.providerRef))).limit(1);
          if (dupe) break;
          const rows = await tx.insert(s.subscriptionInvoicePayment).values(m.row).onConflictDoNothing().returning({ id: s.subscriptionInvoicePayment.id });
          if (rows[0]) out.invoicePaymentId = rows[0].id;
          break;
        }
      }
    }
    return out;
  };

  // 4. monotone kinds: guarded mutation, no operation row, no effects
  if (MONOTONE_KINDS.has(op.kind)) {
    const r = await apply();
    return { created: true, replayed: false, operationRowId: null, paymentId: r.paymentId, effectIds: [] };
  }

  // 5. once kinds: the operation row is the identity; a conflict is a replay
  // 5a. operator resolution: the target must exist; only one entitlement-bearing resolution per target
  let heldTargetEffects: string[] = [];
  if (op.kind === 'operator_resolution') {
    const r = op.resolution!;
    const [target] = await tx.select({ id: s.settlementOperation.id }).from(s.settlementOperation).where(and(
      eq(s.settlementOperation.storeId, op.storeId), eq(s.settlementOperation.operationKind, r.targetKind), eq(s.settlementOperation.operationId, r.targetId))).limit(1);
    if (!target) throw new Error('operator resolution target operation does not exist');
    const [sameKey] = await tx.select({ id: s.settlementOperation.id }).from(s.settlementOperation).where(and(
      eq(s.settlementOperation.storeId, op.storeId), eq(s.settlementOperation.operationKind, 'operator_resolution'), eq(s.settlementOperation.operationId, operationId))).limit(1);
    if (authorized.length && !sameKey) {
      const [prior] = await tx.select({ id: s.settlementOperation.id }).from(s.settlementOperation).where(and(
        eq(s.settlementOperation.storeId, op.storeId), eq(s.settlementOperation.operationKind, 'operator_resolution'),
        eq(s.settlementOperation.targetKind, r.targetKind), eq(s.settlementOperation.targetId, r.targetId),
        sql`${s.settlementOperation.authorizedEffects} <> '{}'`)).limit(1);
      if (prior) throw new Error('an entitlement-bearing resolution already exists for this target');
    }
    heldTargetEffects = (await tx.select({ id: s.orderPendingEffect.id }).from(s.orderPendingEffect).where(and(
      eq(s.orderPendingEffect.storeId, op.storeId), eq(s.orderPendingEffect.operationKind, r.targetKind),
      eq(s.orderPendingEffect.operationId, r.targetId), eq(s.orderPendingEffect.status, 'terminal')))).map((e) => e.id);
  }
  let snapshot: object | null = null;
  const purge = op.mutations.find((m): m is Extract<SettlementMutation, { type: 'order_purge' }> => m.type === 'order_purge');
  if (purge) {
    snapshot = (await tx.select({ id: s.payment.id, method: s.payment.method, provider_ref: s.payment.providerRef, amount: s.payment.amount, state: s.payment.state })
      .from(s.payment).where(and(eq(s.payment.storeId, op.storeId), eq(s.payment.orderId, purge.orderId)))) as object[];
  }
  const [opRow] = await tx.insert(s.settlementOperation).values({
    storeId: op.storeId, operationKind: op.kind, operationId,
    targetKind: op.resolution?.targetKind ?? null, targetId: op.resolution?.targetId ?? null,
    actor: op.resolution?.actor ?? null, reason: op.resolution?.reason ?? null, snapshot,
    classification: op.classification ?? null,
    authorizedEffects: op.kind === 'stripe_invoice_paid' || op.kind === 'operator_resolution' ? [...authorized] : [],
    disposition: op.disposition ?? null,
    paymentIntent: op.provider?.ref ?? null, providerAccount: op.provider?.account ?? null, providerMode: op.provider?.mode ?? null,
  }).onConflictDoNothing({
    target: [s.settlementOperation.storeId, s.settlementOperation.operationKind, s.settlementOperation.operationId],
  }).returning({ id: s.settlementOperation.id });
  if (!opRow) {
    // A replay mutates nothing, so it is correct only if the mutations it would have made are already
    // in the applied state. The operation row alone is not that proof (a row without its order_paid
    // would otherwise be silently skipped): refuse loudly instead of reporting a Paid settlement.
    for (const m of op.mutations) {
      if (m.type === 'order_paid') {
        const [cur] = await tx.select({ state: s.order.state }).from(s.order)
          .where(and(eq(s.order.id, m.orderId), eq(s.order.storeId, op.storeId))).limit(1);
        if (!cur || canTransition(cur.state as OrderState, 'Paid')) {
          throw new Error(`settlement replay of "${op.kind}" would skip an unapplied order_paid (order ${m.orderId} is ${cur?.state ?? 'missing'})`);
        }
      } else if (m.type === 'order_insert' && m.rows[0]?.id) {
        const [cur] = await tx.select({ id: s.order.id }).from(s.order)
          .where(and(eq(s.order.id, m.rows[0].id), eq(s.order.storeId, op.storeId))).limit(1);
        if (!cur) throw new Error(`settlement replay of "${op.kind}" would skip an unapplied order_insert (order ${m.rows[0].id} is missing)`);
      }
    }
    const [existing] = await tx.select().from(s.settlementOperation).where(and(
      eq(s.settlementOperation.storeId, op.storeId), eq(s.settlementOperation.operationKind, op.kind), eq(s.settlementOperation.operationId, operationId),
    )).limit(1);
    const prior = await tx.select({ id: s.orderPendingEffect.id }).from(s.orderPendingEffect).where(and(
      eq(s.orderPendingEffect.storeId, op.storeId), eq(s.orderPendingEffect.operationKind, op.kind), eq(s.orderPendingEffect.operationId, operationId),
    ));
    if (op.classification && existing?.classification && existing.classification !== op.classification) {
      await tx.insert(s.auditLog).values({
        storeId: op.storeId, actor: 'system:settlement', entity: 'settlement_operation', entityId: existing.id,
        action: 'settlement_classification_replayed',
        data: { operationKind: op.kind, operationId: op.operationId, stored: existing.classification, observed: op.classification },
      });
    }
    return {
      created: false, replayed: true, operationRowId: existing?.id ?? null, paymentId: existing?.paymentId ?? undefined,
      invoicePaymentId: existing?.invoicePaymentId ?? undefined, effectIds: prior.map((r) => r.id),
      storedClassification: (existing?.classification as InvoiceClassification | null) ?? undefined,
    };
  }

  const applied = await apply();
  // An operation that IS a payment insert but inserted nothing (provider-ref conflict): not a new fact.
  if (PAYMENT_IDENTITY_KINDS.has(op.kind) && op.mutations.some((m) => m.type === 'payment_insert') && applied.paymentId === undefined) {
    await tx.delete(s.settlementOperation).where(eq(s.settlementOperation.id, opRow.id));
    return { created: false, replayed: false, operationRowId: null, effectIds: [] };
  }
  await tx.update(s.settlementOperation).set({
    paymentId: applied.paymentId ?? null, orderId: applied.orderId ?? op.orderId ?? null, invoicePaymentId: applied.invoicePaymentId ?? null,
  }).where(eq(s.settlementOperation.id, opRow.id));

  if (op.kind === 'operator_resolution' && op.resolution!.action === 'apply' && heldTargetEffects.length) {
    await tx.update(s.orderPendingEffect).set({ resolvedBy: opRow.id }).where(inArray(s.orderPendingEffect.id, heldTargetEffects));
  }
  const created = await enqueueEffects(tx, op.storeId, { kind: op.kind, id: operationId }, op.effects);
  if ((op.effectMode ?? 'inline') === 'inline') await executeEffectsNow(tx, created.map((r) => r.id));
  return {
    created: true, replayed: false, operationRowId: opRow.id, paymentId: applied.paymentId,
    invoicePaymentId: applied.invoicePaymentId, effectIds: created.map((r) => r.id), storedClassification: op.classification,
  };
}

// ── effect-set builders for the built-in operations (pure; no table access) ──

/**
 * The fulfilment fan-out of a Paid transition. `variant` selects the notification /
 * loyalty flavour each path always had: 'settle' for the async paid paths (gateway
 * settle, webhook reconcile, /pay) or 'checkout' for the synchronous checkout
 * (zero-total / full gift-card cover). `only` narrows the set (admin manual order:
 * licence issuance alone).
 */
export function paidOrderEffects(a: {
  orderId: string; customerId: string | null; paidAt: Date; variant: 'settle' | 'checkout';
  guestEmail?: string | null; itemCount?: number; only?: 'license_issue';
}): EffectRequest[] {
  const paidAt = a.paidAt.toISOString();
  const issue: EffectRequest = { kind: 'license_issue', payload: { orderId: a.orderId, customerId: a.customerId, paidAt } };
  if (a.only === 'license_issue') return [issue];
  return [
    issue,
    { kind: 'loyalty_earn', payload: { variant: a.variant, orderId: a.orderId, paidAt } },
    { kind: 'notification', payload: { variant: a.variant, orderId: a.orderId, guestEmail: a.guestEmail ?? null, itemCount: a.itemCount ?? 0 } },
  ];
}

/** Effects for a balance payment that clears an order edit: entitlement reconcile + the deferred edit earn. */
export function editBalanceEffects(a: { orderId: string; customerId: string | null; deferredEarn?: boolean }): EffectRequest[] {
  return [
    { kind: 'edit_reconcile', payload: { orderId: a.orderId, customerId: a.customerId, paidAt: new Date().toISOString() } },
    ...(a.deferredEarn === false ? [] : [{ kind: 'loyalty_earn' as const, payload: { variant: 'deferred_edit', orderId: a.orderId } }]),
  ];
}
