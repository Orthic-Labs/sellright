/**
 * Canonical settlement-operation table (de-fork plan 2.8; SETTLEMENT-OPS.md sections
 * 2-4). Operation identity is path-independent: it is the provider / business
 * FACT (an invoice id, a payment id, an order id, an order-edit id), never the
 * code path that observed it. For each kind this module states which mutations
 * recordSettlementOperation() will perform and which effect kinds the operation
 * is eligible to create; anything else is rejected (a duplicate capture can
 * never issue a licence, a historical import can never trigger fulfilment).
 * Both lists are exhaustive over the kinds at compile time (`satisfies Record`).
 */

export const SETTLEMENT_KINDS = [
  'stripe_invoice_paid',
  'payment_settled',
  'payment_state_progress',
  'order_paid_transition',
  'admin_draft_create',
  'order_edit_balance_settled',
  'duplicate_capture_recorded',
  'historical_import',
  'synthetic_seed',
  'payment_mode_corrected',
  'order_purge',
  'operator_resolution',
] as const;
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

/**
 * Effect kinds in EXECUTION RANK ORDER: within one operation a later-rank effect
 * is not claimed while an earlier-rank sibling is still pending/processing.
 * `admin_review` never executes (always born `terminal`).
 */
export const EFFECT_KINDS = [
  'license_issue',
  'license_extend',
  'edit_reconcile',
  'loyalty_earn',
  'notification',
  'admin_review',
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

/** `once` kinds own a settlement_operation row (UNIQUE identity); `monotone` kinds are guarded updates with no row and no effects. */
export const MONOTONE_KINDS: ReadonlySet<SettlementKind> = new Set<SettlementKind>(['payment_state_progress', 'payment_mode_corrected']);

export type MutationType =
  | 'payment_insert' | 'payment_state' | 'payment_gateway_identity'
  | 'order_paid' | 'order_insert' | 'invoice_payment_record' | 'order_purge';

export interface OperationPolicy {
  /** What `operationId` is. */
  identity: string;
  mutations: readonly MutationType[];
  /** Eligible effect kinds. For stripe_invoice_paid the frozen classification narrows this (INVOICE_AUTHORIZED_EFFECTS). */
  effects: readonly EffectKind[];
}

export const OPERATION_POLICY = {
  stripe_invoice_paid: {
    identity: 'Stripe invoice.id',
    mutations: ['payment_insert', 'order_paid', 'invoice_payment_record'],
    effects: ['license_issue', 'loyalty_earn', 'notification', 'license_extend', 'edit_reconcile', 'admin_review'],
  },
  payment_settled: {
    identity: 'payment.id',
    mutations: ['payment_insert', 'payment_state'],
    // only when the payment lands on an already-Paid order with amount due >= 0 (settle balance branch)
    effects: ['edit_reconcile', 'loyalty_earn'],
  },
  payment_state_progress: {
    identity: 'payment.id (monotone, no operation row)',
    mutations: ['payment_insert', 'payment_state', 'payment_gateway_identity'],
    effects: [],
  },
  order_paid_transition: {
    identity: 'order.id',
    mutations: ['order_paid', 'order_insert', 'payment_insert'],
    effects: ['license_issue', 'loyalty_earn', 'notification'],
  },
  // An admin draft created UNPAID (state PendingPayment). Its own kind, so the order.id key is not
  // consumed: the later real Paid transition of the same order is order_paid_transition(order.id).
  admin_draft_create: { identity: 'order.id', mutations: ['order_insert'], effects: [] },
  order_edit_balance_settled: {
    identity: 'order_edit.id',
    mutations: ['payment_insert', 'payment_state'],
    effects: ['edit_reconcile', 'loyalty_earn'],
  },
  duplicate_capture_recorded: {
    identity: 'payment.id of the duplicate row',
    mutations: ['payment_insert'],
    effects: ['notification'], // operator alert only — NEVER license_issue / loyalty_earn / edit_reconcile
  },
  historical_import: { identity: 'order.id / payment.id', mutations: ['payment_insert', 'order_insert'], effects: [] },
  synthetic_seed: { identity: 'order.id', mutations: ['order_insert'], effects: [] },
  payment_mode_corrected: {
    identity: 'payment.id (monotone, no operation row)',
    mutations: ['payment_gateway_identity'],
    effects: [],
  },
  // Admin hard purge of an order: payments are snapshotted on the operation row FIRST (so invoice
  // evidence survives), then the payment rows and the order row are deleted.
  order_purge: { identity: 'order.id', mutations: ['order_purge'], effects: [] },
  // A human decision executing the held entitlement/money of a terminal / hold_money target.
  operator_resolution: {
    identity: '<target_kind>:<target_id>:<resolution_id>',
    mutations: ['invoice_payment_record', 'payment_insert', 'order_paid'],
    effects: ['license_issue', 'license_extend', 'loyalty_earn', 'notification', 'edit_reconcile'],
  },
} as const satisfies Record<SettlementKind, OperationPolicy>;

export type InvoiceClassification = 'first_cycle' | 'renewal' | 'adjustment' | 'unresolved';

/** Entitlement authorized by a frozen classification (SETTLEMENT-OPS 4). `admin_review` is always allowed as a hold. */
export const INVOICE_AUTHORIZED_EFFECTS = {
  // edit_reconcile: a first-cycle invoice landing on an order already in the paid lifecycle (balance branch, SETTLEMENT-OPS 4)
  first_cycle: ['license_issue', 'loyalty_earn', 'notification', 'edit_reconcile', 'admin_review'],
  renewal: ['license_extend', 'admin_review'],
  adjustment: ['admin_review'],
  unresolved: ['admin_review'],
} as const satisfies Record<InvoiceClassification, readonly EffectKind[]>;

export function effectRank(kind: string): number {
  const i = (EFFECT_KINDS as readonly string[]).indexOf(kind);
  return i < 0 ? EFFECT_KINDS.length : i;
}
