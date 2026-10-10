// Reservation transition dispatch (PAYMENT-TIMING.md §3.1 hook 5, §3.3 projections).
//
// Every reservation state change calls each registered policy's onReservationTransition inside the
// transaction that made the change. A projection failure is NOT isolated: the transition and its
// projection commit or roll back together (the rollback-compatibility rule of §3.3). The failure
// therefore surfaces as PaymentPolicyUnavailableError and the caller's transaction aborts.
import type { Tx } from '../../db/client.js';
import { inSavepoint, registeredPaymentPolicies } from './registry.js';
import type { ReservationRow } from '../reservation.js';
import type { ReservationTransition } from './types.js';

export async function dispatchReservationTransition(tx: Tx, t: ReservationTransition): Promise<void> {
  for (const policy of registeredPaymentPolicies()) {
    if (!policy.onReservationTransition) continue;
    await inSavepoint(tx, policy.id, () => policy.onReservationTransition!(tx, t));
  }
}

/** Dispatches one transition per row, in order. */
export async function dispatchReservationTransitions(tx: Tx, rows: readonly ReservationRow[], from: ReservationTransition['from'], to: ReservationTransition['to'], cause: ReservationTransition['cause']): Promise<void> {
  for (const reservation of rows) await dispatchReservationTransition(tx, { reservation, from, to, cause });
}
