// Payment policy contract (de-fork plan 3.4; PAYMENT-TIMING.md §3.1, §3.3, §3.6, §4.5, §4.6).
//
// A policy supplies app-specific payment decisions at fixed, transactional hooks. The engine
// owns the attempt rows, reservation rows, provider calls and HTTP mapping. Hooks run inside the
// transaction the caller owns: they never call a provider, never write payment/payment_attempt
// rows, and see the order row already locked through a HeldLocks brand (db/locks.ts).
//
// Hooks and their call sites:
//   beforePaymentAttempt       gateway-payment.ts (NMI, Sezzle start), routes/pay.ts (/payment-intent)
//   beforeCapture              jobs/gateway-recovery.ts (Sezzle decision tx)
//   authorizeInvoiceEffect     payments/settlement/handlers.ts (license_extend, first-cycle license_issue)
//   revalidateForIssuance      payments/settlement/handlers.ts (license_issue, issuing)
//   onReservationTransition    payments/reservation.ts (every reservation state change)
//   shapeSettlementResponse    routes/pay.ts (response shaping only, after money is recorded)
//   lockPlan                   db/locks.ts (STOREKIT §5.3 plan contributor)
//   onEntitlementReversal      payments/settlement/handlers.ts (entitlement_reversal effect, worker; full refund or lost chargeback)
//   checkoutEligibility        routes/checkout.ts (before any discount, loyalty or tax step)
//   onCheckoutOrder            routes/checkout.ts (after the order and line inserts; refusal, promotion replacement, adjustment)
//   checkoutReplayAllowed      routes/checkout.ts (the three idempotency replay sites; origin-aware, structured refusal)
//   legacyCheckoutFingerprint  routes/checkout.ts (idempotency replay sites, after replay authorization)
import type { Tx } from '../../db/client.js';
import type { HeldLocks, LockPlanContribution, LockSubject } from '../../db/locks.js';
import type { ReservationRow } from '../reservation.js';

/** The tender an attempt is for. `zero_total`/`gift_card` are placement tenders (no provider call). */
export type PaymentProvider = 'nmi' | 'stripe' | 'sezzle' | 'gift_card' | 'manual' | 'zero_total';

/**
 * checkout   order is PendingPayment
 * balance    order is Paid|PartiallyRefunded with an amount due (isBalanceState)
 * placement  tender recorded in the same tx that creates/pays the order (later steps)
 */
export type PaymentPurpose = 'checkout' | 'balance' | 'placement';

export interface PolicyOrder {
  readonly id: string;
  readonly storeId: string;
  readonly code: string;
  readonly state: string;
  readonly currency: string;
  readonly grandTotal: number;
  readonly customerId: string | null;
  readonly metadata: unknown;
}

/**
 * A veto refuses the attempt for this request only and is stateless: a later request
 * re-evaluates the policy. `code` is the stable wire code; `message` is customer-visible.
 */
export interface PolicyVeto {
  readonly code: string;
  readonly message: string;
  readonly extra?: { readonly state?: string };
}

/**
 * A reservation a policy asks the engine to create in the preparation transaction (PAYMENT-TIMING §3.3 R1).
 * `ownerKey` identifies the reserved thing (e.g. a source licence id). `expiresAt` must be null:
 * provider-bound money has no fixed expiry.
 */
export interface ReservationRequest {
  /** Namespaced by the policy, e.g. 'rightsuite.mobile_upgrade_credit'. */
  readonly kind: string;
  readonly ownerKey: string;
  /** Opaque policy payload; the engine never reads it. */
  readonly holder?: Readonly<Record<string, unknown>>;
  readonly expiresAt?: null;
  readonly releaseOnFullRefund?: boolean;
}

export interface BeforePaymentAttemptInput {
  readonly provider: PaymentProvider;
  readonly purpose: PaymentPurpose;
  /** Order row already locked FOR UPDATE by the caller under `held`. */
  readonly order: PolicyOrder;
  /** The order's reservation rows (locked under `held`), any state. */
  readonly reservations: readonly ReservationRow[];
  readonly held: HeldLocks;
}

export type BeforePaymentAttemptResult =
  | { readonly allow: true; readonly reserve?: readonly ReservationRequest[] }
  | { readonly allow: false; readonly veto: PolicyVeto };

/**
 * Immediately before the engine issues a provider capture (Sezzle only; PAYMENT-TIMING §4.4).
 * `attempt.providerRef` is the Sezzle order uuid the capture targets.
 */
export interface BeforeCaptureInput {
  readonly provider: 'sezzle';
  /** Order row already locked FOR UPDATE by the caller under `held`. */
  readonly order: PolicyOrder;
  readonly attempt: { readonly id: string; readonly amount: number; readonly currency: string; readonly providerRef: string };
  readonly reservations: readonly ReservationRow[];
  readonly held: HeldLocks;
}

/**
 * `capture`: the engine captures. `cancel`: the engine releases the Sezzle authorisation instead;
 * `reason` is a machine code persisted in payment_attempt.context.capture_decision.
 */
export type BeforeCaptureResult =
  | { readonly action: 'capture' }
  | { readonly action: 'cancel'; readonly reason: string };

/** Subscription invoice classification (plan 2.8). Immutable once recorded. */
export type InvoiceCycle = 'first_cycle' | 'renewal' | 'adjustment';

/**
 * Entitlement-granting effect about to run in the effects worker (PAYMENT-TIMING §4.5). Never runs in the
 * recording transaction: money is recorded regardless of the decision.
 */
export interface AuthorizeInvoiceEffectInput {
  readonly storeId: string;
  /** 'stripe_invoice_paid:<invoice.id>' (SETTLEMENT-OPS.md). */
  readonly operationId: string;
  readonly effectKind: 'issuance' | 'renewal_extension';
  readonly cycle: InvoiceCycle;
  readonly invoice: {
    readonly id: string;
    readonly subscriptionId: string;
    readonly paymentIntentId: string | null;
    readonly billingReason: string | null;
    readonly amountPaid: number | null;
    readonly periodEnd: Date | null;
  };
  readonly subscription: { readonly id: string; readonly status: string; readonly licenseId: string | null; readonly orderId: string | null };
  /** The subscription's licence, locked by the effect's lock set; null when none is linked yet. */
  readonly license: { readonly id: string; readonly status: string; readonly expiresAt: Date | null; readonly updatesUntil: Date | null; readonly metadata: unknown } | null;
  readonly order: PolicyOrder | null;
  readonly held: HeldLocks;
}

export type InvoiceEffectDecision =
  | { readonly decision: 'apply' }
  | { readonly decision: 'terminal'; readonly code: string; readonly adminTask: { readonly title: string; readonly detail: string } };

/** Revalidation when an issuance effect executes (PAYMENT-TIMING §3.7.5). Money and order state are untouched on failure. */
export interface RevalidateForIssuanceInput {
  readonly order: PolicyOrder;
  readonly reservations: readonly ReservationRow[];
  readonly held: HeldLocks;
}

/**
 * `ok: true` may carry `metadataPatch`: a shallow patch merged into the metadata of every licence the order
 * has once the issuance runs, in the same transaction, under the order's lock set. Patches from several
 * policies merge in registration order; the same key from two policies is a PaymentPolicyCompositionError.
 * `ok: false` blocks issuance before any licence row is written; `audit` (when present) is recorded.
 */
export type RevalidateForIssuanceResult =
  | { readonly ok: true; readonly metadataPatch?: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: string; readonly audit?: { readonly action: string; readonly data: Record<string, unknown> } };

/** A reservation state change, delivered to projections in the transaction that made it (PAYMENT-TIMING §3.3). */
export interface ReservationTransition {
  /** The row after the transition. */
  readonly reservation: ReservationRow;
  readonly from: ReservationRow['state'] | null;
  readonly to: ReservationRow['state'];
  readonly cause: 'reserved' | 'consumed' | 'order_cancelled' | 'order_refunded' | 'order_purged' | 'operator_override';
}

/** Input to shapeSettlementResponse. The money is already recorded; the hook may only describe the response. */
export interface SettlementResponseInput {
  readonly route: 'pay';
  readonly order: PolicyOrder;
  readonly recordedPaymentId: string | null;
  readonly held: HeldLocks;
}

/** Replaces the default /pay success body with a wire error. `message` defaults to `code` when omitted. */
export interface SettlementResponseOverride {
  readonly status: 409;
  readonly code: string;
  readonly message?: string;
  readonly extra?: { readonly state?: string };
}

// ── 6. checkout (PAYMENT-TIMING §3.3 R1; X-57) ────────────────────────────────────────────
/** Structural schema for a policy's checkout extension block (zod schemas satisfy it). */
export interface CheckoutExtensionSchema {
  safeParse(input: unknown): { success: true; data: unknown } | { success: false };
}

/** The signed-in session customer, or null for a guest checkout. */
export interface PolicyCustomer {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

/** One checkout order line as inserted by the engine in the same transaction. */
export interface CheckoutLine {
  readonly variantId: string;
  readonly sku: string;
  readonly productId: string;
  readonly quantity: number;
  readonly unitPrice: number;
}

/**
 * The checkout request's discount and tender intent exactly as the client sent it (zod-validated), whether or not
 * a coupon, gift card or points redemption ends up applying. A policy that forbids a combination reads it here
 * rather than inferring it from what applied.
 */
export interface CheckoutRequestIntent {
  readonly couponCode?: string;
  readonly giftCardCode?: string;
  readonly redeemPoints?: number;
}

/**
 * A checkout refusal with its own wire shape. Distinct from PolicyVeto, whose 409 + `state` defaults belong to
 * placement and payment vetoes: a refusal answers with exactly `status`, `code`, `message`, and `extra` as top-level
 * siblings of `error`. No `state` is added unless the policy supplies one in `extra`.
 */
export interface CheckoutRefusal {
  readonly status: 409 | 422;
  readonly code: string;
  readonly message: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface CheckoutOrderInput {
  /**
   * The order row inserted by the engine, pre-adjustment and pre-replacement: its grandTotal is before any policy
   * price adjustment and before any `replacePromotion` result.
   */
  readonly order: PolicyOrder;
  readonly lines: readonly CheckoutLine[];
  /** This policy's validated extension block, or undefined when the request carried none. */
  readonly extensions: unknown;
  readonly customer: PolicyCustomer | null;
  /** The request's couponCode / giftCardCode / redeemPoints as sent. */
  readonly intent: CheckoutRequestIntent;
  readonly held: HeldLocks;
}

/**
 * Runs before any discount, loyalty or tax processing, in the checkout transaction (stock already reserved, no order
 * row yet). The order does not exist, so this is request eligibility only: a refusal rolls the checkout back with the
 * refusal's own status and code, and no loyalty or promotion step can substitute a different error first.
 */
export interface CheckoutEligibilityInput {
  readonly storeId: string;
  readonly currency: string;
  readonly lines: readonly CheckoutLine[];
  /** This policy's validated extension block, or undefined when the request carried none. */
  readonly extensions: unknown;
  /** The signed-in session customer, or null (an email-matched guest is not a session customer). */
  readonly customer: PolicyCustomer | null;
  /** The request's couponCode / giftCardCode / redeemPoints as sent. */
  readonly intent: CheckoutRequestIntent;
  readonly held: HeldLocks;
}

export type CheckoutEligibilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: CheckoutRefusal };

/** An order-level price adjustment row (`order_adjustment`). Minor units, may be negative. Untaxed. */
export interface CheckoutPriceAdjustment {
  readonly code: string;
  readonly label: string;
  readonly amount: number;
}

/**
 * Replaces whatever promotion the engine applied (coupon or automatic) with a fixed merchandise discount, before tax,
 * as if it were the order's promotion. The displaced promotion's attribution and usage are dropped: no promotionId on
 * the order, no promotion_usage row, no used_count increment. `fixedDiscount` is minor units, a non-negative integer
 * (0 still displaces the promotion); the totals function caps it at the merchandise subtotal.
 */
export interface CheckoutPromotionReplacement {
  readonly fixedDiscount: number;
}

export interface CheckoutOrderResult {
  /** Placement-style veto: 409 with `state` defaulting to the code. Use `refusal` for any other wire shape. */
  readonly veto?: PolicyVeto;
  /** A refusal with its own status and extras. Mutually exclusive with `veto`. */
  readonly refusal?: CheckoutRefusal;
  /** Merged into order.metadata. Keys owned by the engine, or claimed by another policy, are refused. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly reserve?: readonly ReservationRequest[];
  /**
   * The engine recomputes and persists discount, tax and grand totals, per-line discount and total, and the loyalty
   * earn snapshot, and clears the promotion before settlement. At most one policy may replace the promotion.
   * Applied before `priceAdjustment`.
   */
  readonly replacePromotion?: CheckoutPromotionReplacement;
  readonly priceAdjustment?: CheckoutPriceAdjustment;
}

/** Which replay site is asking: same Idempotency-Key, an already-converted cart, or the loser of a unique-key race. */
export type CheckoutReplayOrigin = 'idempotency_key' | 'converted_cart' | 'unique_violation';

export interface CheckoutReplayInput {
  readonly existingOrder: PolicyOrder;
  /** This policy's validated extension block for the replayed request, or undefined. */
  readonly extensions: unknown;
  readonly customer: PolicyCustomer | null;
  readonly origin: CheckoutReplayOrigin;
  readonly held: HeldLocks;
}

/**
 * A structured replay refusal. Unset `status` is 422 and unset `code` is LEGAL_ACCEPTANCE_REQUIRED, so a policy
 * normally supplies only the `message` it wants the caller to see for this origin.
 */
export interface CheckoutReplayRefusal {
  readonly allow: false;
  readonly message: string;
  readonly code?: string;
  readonly status?: 409 | 422;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * The canonical, normalized request the engine fingerprints (everything but `extensions`): key order is the hashed
 * order, `items` is null when a cartToken is present, `redeemPoints` is present only when truthy, email and addresses
 * are normalized, and `legalAcceptance` is key-sorted JSON. The engine hashes
 * sha256(JSON.stringify({ ...basis, ...(extensions present ? { extensions } : {}) })).
 */
export interface CheckoutFingerprintBasis {
  readonly v: 1;
  readonly cartToken: string | null;
  readonly items: ReadonlyArray<{ readonly sku: string; readonly quantity: number }> | null;
  readonly couponCode: string | null;
  readonly giftCardCode: string | null;
  readonly redeemPoints?: number;
  readonly shippingMethodCode: string | null;
  readonly email: string | null;
  readonly shippingAddress: Readonly<Record<string, unknown>> | null;
  readonly billingAddress: Readonly<Record<string, unknown>> | null;
  readonly legalAcceptance: unknown;
}

/**
 * Asks a policy for the fingerprint an order created by an earlier deployment would have stored for this request.
 * Consulted only at an idempotency replay (never the converted-cart site), only after every replay policy allowed the
 * replay, and only when the normal fingerprint does not match the stored one.
 */
export interface CheckoutLegacyFingerprintInput {
  /** The stored order whose key is being replayed; the candidate is compared with this order's stored fingerprint only. */
  readonly existingOrder: PolicyOrder;
  /** This policy's validated extension block for the replayed request, or undefined. */
  readonly extensions: unknown;
  readonly customer: PolicyCustomer | null;
  readonly origin: Exclude<CheckoutReplayOrigin, 'converted_cart'>;
  /** The complete normalized request, as hashed for a new order. */
  readonly request: CheckoutFingerprintBasis;
  readonly held: HeldLocks;
}

/** Why an order's entitlement is being reversed (the order is Refunded, or a chargeback was lost). */
export type EntitlementReversalReason = 'full_refund' | 'chargeback';

/**
 * Entitlement reversal for an order whose money was fully returned or lost to a chargeback (worker effect).
 * `operationId` is the settlement operation fact (the order id for a full refund, the dispute id for a chargeback).
 * Runs in the effects worker under the order's lock set, never in the recording transaction.
 */
export interface EntitlementReversalInput {
  readonly storeId: string;
  readonly orderId: string;
  readonly reason: EntitlementReversalReason;
  readonly operationId: string;
  /** The order's lock set, held on the effect's transaction. */
  readonly held: HeldLocks;
}

export interface PaymentPolicy {
  /** Unique registration id (e.g. 'sellright-default', 'rightsuite'). */
  readonly id: string;
  /**
   * Optional: schema for this policy's `extensions[id]` block on POST /v1/shop/checkout. Validated before
   * the idempotency fingerprint is computed; a failure is a 400. Absent means the policy accepts no block.
   */
  readonly checkoutExtensions?: CheckoutExtensionSchema;
  /**
   * Optional: request eligibility, run in SAVEPOINT before any discount, loyalty or tax step (see CheckoutEligibilityInput).
   * A refusal rolls the whole checkout back with the refusal's own status and code.
   */
  checkoutEligibility?(tx: Tx, i: CheckoutEligibilityInput): Promise<CheckoutEligibilityResult>;
  /**
   * Optional: runs inside the checkout transaction right after the order and line inserts, in SAVEPOINT.
   * A veto or refusal rolls the whole checkout back; reserve requests become held rows.
   */
  onCheckoutOrder?(tx: Tx, i: CheckoutOrderInput): Promise<CheckoutOrderResult>;
  /**
   * Optional: consulted at every idempotency replay site (same key, converted cart, unique-violation race)
   * before the existing order is returned. `true` allows. `false` refuses with 422 LEGAL_ACCEPTANCE_REQUIRED and the
   * engine's generic message; a CheckoutReplayRefusal refuses with the policy's own message, code and status.
   * `i.origin` names the site so the policy can choose its rule and message per origin.
   */
  checkoutReplayAllowed?(tx: Tx, i: CheckoutReplayInput): Promise<boolean | CheckoutReplayRefusal>;
  /**
   * Optional: a legacy fingerprint candidate for the stored order (null = none). See CheckoutLegacyFingerprintInput.
   * The engine never rewrites or waives the stored fingerprint: the candidate is accepted only by exact equality with it.
   */
  legacyCheckoutFingerprint?(tx: Tx, i: CheckoutLegacyFingerprintInput): Promise<string | null>;
  /** Runs before any attempt row, replay lookup, provider session or intent creation. */
  beforePaymentAttempt(tx: Tx, i: BeforePaymentAttemptInput): Promise<BeforePaymentAttemptResult>;
  /** Optional: absent means capture (default allow). Runs inside the recovery decision transaction. */
  beforeCapture?(tx: Tx, i: BeforeCaptureInput): Promise<BeforeCaptureResult>;
  /** Optional: absent means apply. Runs in the effects worker, never in the recording transaction. */
  authorizeInvoiceEffect?(tx: Tx, i: AuthorizeInvoiceEffectInput): Promise<InvoiceEffectDecision>;
  /** Optional: absent means ok. Runs inside the issuance effect's transaction under the lock set. */
  revalidateForIssuance?(tx: Tx, i: RevalidateForIssuanceInput): Promise<RevalidateForIssuanceResult>;
  /** Optional projection, in the transition's own transaction (PAYMENT-TIMING §3.3 rollback compatibility). */
  onReservationTransition?(tx: Tx, t: ReservationTransition): Promise<void>;
  /** Optional response shaping for /pay, after the money is recorded. Must not write. */
  shapeSettlementResponse?(tx: Tx, i: SettlementResponseInput): Promise<SettlementResponseOverride | null>;
  /** Optional: absent means no reversal. Runs in the effects worker under the order's lock set; a throw is a bounded retry, then terminal. */
  onEntitlementReversal?(tx: Tx, i: EntitlementReversalInput): Promise<void>;
  /** Optional plan contributor for the lock set (STOREKIT §5.3). Read-only. */
  lockPlan?(tx: Tx, subject: LockSubject): Promise<LockPlanContribution>;
}
