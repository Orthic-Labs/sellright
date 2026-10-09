// Payment policy contract (de-fork plan 3.4; PAYMENT-TIMING.md §3.1, §3.6).
//
// A policy supplies app-specific payment decisions at fixed, transactional hooks. The engine
// owns the attempt rows, provider calls and HTTP mapping. Hooks run inside the preparation
// transaction the caller owns: they never call a provider, never write payment/payment_attempt
// rows, and see the order row already locked through a HeldLocks brand (db/locks.ts).
//
// Step 4 wires only `beforePaymentAttempt`. Later hooks (beforeCapture, authorizeInvoiceEffect,
// revalidateForIssuance, reservation projections) are added with their call sites.
import type { Tx } from '../../db/client.js';
import type { HeldLocks } from '../../db/locks.js';
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
  | { readonly allow: true }
  | { readonly allow: false; readonly veto: PolicyVeto };

export interface PaymentPolicy {
  /** Unique registration id (e.g. 'sellright-default', 'rightsuite'). */
  readonly id: string;
  /** Runs before any attempt row, replay lookup, provider session or intent creation. */
  beforePaymentAttempt(tx: Tx, i: BeforePaymentAttemptInput): Promise<BeforePaymentAttemptResult>;
}
