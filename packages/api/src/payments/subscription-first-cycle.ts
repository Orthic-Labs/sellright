/**
 * First-cycle subscription settlement arithmetic (pure).
 *
 * The payment is recorded at what the provider actually collected (invoice.amount_paid), never at the order total.
 * The order may move to Paid only when that collected amount covers what is still due on the order
 * (`due` = amountDueForOrder: grand total minus earlier settled tender). A short or zero (trial) payment records
 * the money, leaves the order unpaid, and is flagged for admin review.
 */
export type FirstCycleOutcome = {
  /** Amount still owed after this payment; <= 0 means covered (negative = overpaid). */
  remaining: number;
  /** Move the order to Paid. */
  transitions: boolean;
  /** Payment on an order already in the paid lifecycle (balance payment). */
  balance: boolean;
  /** Collected amount differs from the order grand total: audit + admin review. */
  mismatch: boolean;
};

export function firstCycleOutcome(a: { due: number; amountPaid: number; grandTotal: number; payable: boolean; paidLifecycle: boolean }): FirstCycleOutcome {
  const remaining = a.due - a.amountPaid;
  return {
    remaining,
    transitions: a.payable && remaining <= 0,
    balance: !a.payable && a.paidLifecycle && remaining >= 0,
    mismatch: a.amountPaid !== a.grandTotal,
  };
}
