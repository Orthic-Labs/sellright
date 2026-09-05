export type SinglePaymentSelection<T> =
  | { kind: 'none' }
  | { kind: 'multiple' }
  | { kind: 'single'; payment: T };

/**
 * Order-level refund endpoints can only be correct when there is exactly one
 * settled payment to allocate the refund against. Two rows means either a
 * split tender or multiple billing cycles; choosing "latest" would make the
 * gateway allocation arbitrary. Callers intentionally query with LIMIT 2.
 */
export function selectSingleSettledPayment<T>(payments: readonly T[]): SinglePaymentSelection<T> {
  if (payments.length === 0) return { kind: 'none' };
  if (payments.length > 1) return { kind: 'multiple' };
  return { kind: 'single', payment: payments[0]! };
}
