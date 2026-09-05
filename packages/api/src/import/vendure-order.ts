export type ImportedOrderState = 'PendingPayment' | 'Paid' | 'PartiallyRefunded' | 'Refunded' | 'Cancelled';

/**
 * Map Vendure order lifecycle states into SellRight's smaller payment-centric
 * order state machine without inventing settlement.
 *
 * Vendure's default process considers PaymentSettled and all later fulfillment
 * states completed checkout. PaymentAuthorized is not captured money, so it
 * remains PendingPayment in SellRight. Unknown/custom states also fail closed;
 * a migration must never turn an unrecognized source state into Paid.
 */
export function mapVendureOrderState(sourceState: string): ImportedOrderState {
  switch (sourceState) {
    case 'Cancelled':
      return 'Cancelled';
    case 'Refunded':
      return 'Refunded';
    case 'PartiallyRefunded':
      return 'PartiallyRefunded';
    case 'PaymentSettled':
    case 'PartiallyShipped':
    case 'Shipped':
    case 'PartiallyDelivered':
    case 'Delivered':
      return 'Paid';
    case 'AddingItems':
    case 'ArrangingPayment':
    case 'PaymentAuthorized':
    default:
      return 'PendingPayment';
  }
}

export type ImportedPaymentState = 'Pending' | 'Authorized' | 'Settled' | 'Declined' | 'Failed';

export function mapVendurePaymentState(sourceState: string): ImportedPaymentState {
  switch (sourceState) {
    case 'Authorized':
      return 'Authorized';
    case 'Settled':
      return 'Settled';
    case 'Declined':
      return 'Declined';
    case 'Error':
    case 'Cancelled':
      return 'Failed';
    default:
      return 'Pending';
  }
}
