/** Order payment-lifecycle state machine (rulebook §11). Explicit allowed
 *  transitions; fulfillment (shipping) state lives on fulfillment records. */
export type OrderState = 'PendingPayment' | 'Paid' | 'PartiallyRefunded' | 'Refunded' | 'Cancelled';

const ORDER_TRANSITIONS: Record<OrderState, OrderState[]> = {
  PendingPayment: ['Paid', 'Cancelled'],
  Paid: ['PartiallyRefunded', 'Refunded', 'Cancelled'],
  PartiallyRefunded: ['Refunded'],
  Refunded: [],
  Cancelled: [],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}
