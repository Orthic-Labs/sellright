/**
 * Invoice cycle classification and the history-policy port (de-fork plan 2.8;
 * SETTLEMENT-OPS.md sections 4-5, INVOICE-DISPOSITIONS.md).
 *
 * Every `invoice.paid` observation is classified ONCE, from Stripe's
 * authoritative `invoice.billing_reason`, and the classification is stored on the
 * invoice's settlement_operation row — frozen, reused by every later observation
 * (distinct delivery ids, either old dispatch path).
 *
 *   subscription_create                         -> first_cycle  (licence issue + loyalty + notification; NO extension)
 *   subscription_cycle                          -> renewal      (one licence extension)
 *   subscription_update / _threshold / manual /
 *     upcoming / automatic_pending_invoice_item_invoice -> adjustment (money only, never a period)
 *   subscription (legacy), quote_accept, null, unrecognized -> classified against the
 *     persisted initial invoice (InvoiceHistoryPolicy.initialInvoice):
 *       initial                      -> first_cycle
 *       not initial, reason null     -> renewal
 *       not initial, reason non-null -> adjustment + admin_review hold (never extends automatically, D-4)
 *       unresolved                   -> unresolved + admin_review hold, money held
 *
 * The RightSites plugin implements InvoiceHistoryPolicy over its provider-history
 * tables (rightsuite.subscription_initial_invoice, the pre-adoption baseline and
 * frontier); the engine never reads those. The engine DEFAULT resolves the initial
 * invoice from LOCAL evidence only (a licence already linked, or an earlier
 * first_cycle operation for the same order) and treats "no evidence" as initial —
 * the rule the old dispatch used — so an engine without a plugin behaves as before.
 */
import type { Tx } from '../../db/client.js';
import type { InvoiceClassification } from './ops.js';

export type InvoiceDisposition =
  | 'new' | 'pending_at_frontier' | 'applied' | 'paid_no_effect' | 'handled_no_effect'
  | 'unresolved' | 'ignored_non_subscription' | 'voided';
export type EntitlementAction = 'normal' | 'none' | 'hold' | 'defer';
export type MoneyAction = 'normal' | 'none' | 'record_order_payment' | 'record_orderless' | 'hold_money' | 'defer';

/** Scope key K = (store, stripe account, mode, invoice). */
export interface InvoiceKey {
  storeId: string;
  accountId: string;
  mode: 'test' | 'live';
  invoiceId: string;
  stripeSubscriptionId: string;
  /** Local evidence the default policy uses; a plugin may ignore it. */
  local: { licenceLinked: boolean; priorFirstCycleForOrder: boolean };
}

export interface InvoiceDispositionDecision {
  disposition: InvoiceDisposition;
  entitlementAction: EntitlementAction;
  moneyAction: MoneyAction;
  ruleId?: string;
  reason?: string;
  frontierId?: string;
}

export type InitialInvoiceAnswer = 'initial' | 'not_initial' | 'unresolved';

export interface InvoiceHistoryPolicy {
  /** The pre-adoption baseline decision for this invoice. Default: `new` (normal entitlement, normal money). */
  disposition(tx: Tx, key: InvoiceKey, classification: InvoiceClassification): Promise<InvoiceDispositionDecision>;
  /** Is `key.invoiceId` the subscription's initial invoice? Default: local evidence only. */
  initialInvoice(tx: Tx, key: InvoiceKey): Promise<InitialInvoiceAnswer>;
}

export const defaultInvoiceHistoryPolicy: InvoiceHistoryPolicy = {
  async disposition() { return { disposition: 'new', entitlementAction: 'normal', moneyAction: 'normal' }; },
  async initialInvoice(_tx, key) {
    return key.local.licenceLinked || key.local.priorFirstCycleForOrder ? 'not_initial' : 'initial';
  },
};

let policy: InvoiceHistoryPolicy = defaultInvoiceHistoryPolicy;
export function setInvoiceHistoryPolicy(next: InvoiceHistoryPolicy | null): void { policy = next ?? defaultInvoiceHistoryPolicy; }
export function invoiceHistoryPolicy(): InvoiceHistoryPolicy { return policy; }

/** Stripe's authoritative reason -> classification; null = needs the initial-invoice fallback. */
export function classificationForBillingReason(reason: string | null | undefined): InvoiceClassification | null {
  switch (reason) {
    case 'subscription_create': return 'first_cycle';
    case 'subscription_cycle': return 'renewal';
    case 'subscription_update':
    case 'subscription_threshold':
    case 'manual':
    case 'upcoming':
    case 'automatic_pending_invoice_item_invoice':
      return 'adjustment';
    default: return null;
  }
}

export interface InvoiceClassificationResult {
  classification: InvoiceClassification;
  /** Why the entitlement decision needs a human (adds an admin_review hold). */
  hold?: string;
}

export async function classifyInvoice(tx: Tx, key: InvoiceKey, billingReason: string | null | undefined): Promise<InvoiceClassificationResult> {
  const mapped = classificationForBillingReason(billingReason);
  if (mapped) return { classification: mapped };
  const answer = await policy.initialInvoice(tx, key);
  if (answer === 'initial') return { classification: 'first_cycle' };
  if (answer === 'not_initial') {
    return billingReason == null
      ? { classification: 'renewal' }
      : { classification: 'adjustment', hold: `billing_reason "${billingReason}" on a non-initial invoice` };
  }
  return { classification: 'unresolved', hold: 'initial invoice unresolved' };
}
