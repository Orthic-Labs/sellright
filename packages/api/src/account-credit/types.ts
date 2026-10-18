import type { accountCredit, accountCreditTransaction, AccountCreditAllocation } from '../db/schema-account-credit.js';

export type CreditAccount = typeof accountCredit.$inferSelect;
export type CreditTransaction = typeof accountCreditTransaction.$inferSelect;
export type { AccountCreditAllocation };
export class AccountCreditError extends Error {
  constructor(readonly code: 'invalid_input' | 'missing' | 'unavailable' | 'conflict' | 'allocation' | 'invariant', message: string) {
    super(message);
    this.name = 'AccountCreditError';
  }
}
export type CreditContext = { storeId: string };
export type ReserveCreditInput = CreditContext & {
  orderId: string; accountId: string; appliedAmount: number;
  /** Invoke only at payment preparation, never while adding cart items. */
  phase: 'ArrangingPayment'; now?: Date;
};
export type RedeemCreditInput = CreditContext & {
  orderId: string; appliedAmount: number; allocation: AccountCreditAllocation;
};
export type ReleaseCreditInput = CreditContext & { orderId: string } & (
  { cause: 'cancelled' } | { cause: 'coupon_removed'; couponCode: string }
);
export type RestoreManualInput = CreditContext & {
  accountId: string; orderId: string; orderLineId: string; quantity: number;
  expectedCents: number; operationKey: string; actor: string; reason: string;
};
export type CreditReconciliation = {
  ok: false; event: 'account_credit.reconciliation_required';
  operation: 'redeem' | 'restore_refund'; storeId: string; orderId: string; refundId?: string;
  errorCode: string;
};
export type CreditSettlementResult<T> = { ok: true; value: T } | CreditReconciliation;
