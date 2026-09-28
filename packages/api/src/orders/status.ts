/**
 * Order/payment/fulfillment status — the wire-facing three-way split of the
 * old combined `order.state` (money/fsm.ts). The FSM itself is UNCHANGED and
 * remains the only source of truth for transition guards; everything here is
 * a pure, read-side PROJECTION.
 *
 * - `status` mirrors the Postgres STORED GENERATED `order.status` column
 *   (schema-orders.ts) — computed from `state` + `deletedAt` alone, so
 *   `deriveOrderStatus` below exists mainly for callers that already have an
 *   order row in hand and for unit tests; the DB column is authoritative.
 * - `paymentStatus`/`fulfillmentStatus` are NOT persisted (see migration
 *   0080's header comment for why) — computed here at read time from the
 *   order's payment rows / order lines / fulfillment rows, which are
 *   themselves the existing sources of truth those call sites already
 *   maintain (nothing new to keep in sync).
 *
 * BREAKING (pre-1.0, see CHANGELOG.md): every wire value here is lowercase
 * snake_case, distinct from the internal PascalCase `order_state`/
 * `payment_state`/`fulfillment_state` enums.
 */

export type OrderStatus = 'open' | 'completed' | 'cancelled' | 'archived';
export type OrderPaymentStatus = 'pending' | 'authorized' | 'paid' | 'partially_refunded' | 'refunded' | 'voided' | 'failed';
export type OrderFulfillmentStatus = 'unfulfilled' | 'partially_fulfilled' | 'fulfilled' | 'partially_delivered' | 'delivered';

export const ORDER_STATUS_VALUES: readonly OrderStatus[] = ['open', 'completed', 'cancelled', 'archived'];
export const ORDER_PAYMENT_STATUS_VALUES: readonly OrderPaymentStatus[] = ['pending', 'authorized', 'paid', 'partially_refunded', 'refunded', 'voided', 'failed'];
export const ORDER_FULFILLMENT_STATUS_VALUES: readonly OrderFulfillmentStatus[] = ['unfulfilled', 'partially_fulfilled', 'fulfilled', 'partially_delivered', 'delivered'];

type InternalOrderState = 'PendingPayment' | 'Paid' | 'PartiallyRefunded' | 'Refunded' | 'Cancelled';
type InternalPaymentState = 'Pending' | 'Authorized' | 'Settled' | 'Declined' | 'Failed';
type InternalFulfillmentState = 'Pending' | 'Shipped' | 'Delivered' | 'Cancelled';

/** Matches the `order.status` STORED GENERATED column exactly (migration
 *  0080) — kept here so pure unit tests can cover the mapping without a DB,
 *  and so any caller holding an order row in memory can derive it without a
 *  round trip. The DB column is the actual source of truth on the wire. */
export function deriveOrderStatus(state: InternalOrderState, deletedAt: Date | string | null): OrderStatus {
  if (deletedAt) return 'archived';
  if (state === 'Cancelled') return 'cancelled';
  if (state === 'PendingPayment') return 'open';
  return 'completed'; // Paid | PartiallyRefunded | Refunded
}

/**
 * `order.state` alone can't distinguish pending/authorized/declined/failed —
 * those only exist on individual `payment` rows. `payments` should be every
 * payment row for the order, newest first (`order by created_at desc`, the
 * same ordering `order-facts.ts#loadOrderPayments` already uses).
 *
 * `Settled` payments on a `Cancelled` order are a pre-refund-tracking anomaly
 * (money was captured; refunds.ts always moves the order to
 * Refunded/PartiallyRefunded, never leaves it Cancelled) — reported as `paid`
 * rather than `voided`, since money did in fact move.
 */
export function derivePaymentStatus(state: InternalOrderState, paymentsNewestFirst: Array<{ state: InternalPaymentState }>): OrderPaymentStatus {
  if (state === 'Refunded') return 'refunded';
  if (state === 'PartiallyRefunded') return 'partially_refunded';
  if (state === 'Paid') return 'paid';
  if (state === 'Cancelled') {
    if (paymentsNewestFirst.some((p) => p.state === 'Settled')) return 'paid';
    if (paymentsNewestFirst.some((p) => p.state === 'Authorized')) return 'voided';
    if (paymentsNewestFirst.some((p) => p.state === 'Declined' || p.state === 'Failed')) return 'failed';
    return 'pending';
  }
  // PendingPayment
  const latest = paymentsNewestFirst[0];
  if (!latest) return 'pending';
  if (latest.state === 'Authorized') return 'authorized';
  if (latest.state === 'Declined' || latest.state === 'Failed') return 'failed';
  return 'pending';
}

/**
 * Fulfillment is currently all-or-nothing per order (admin.ts's fulfill route
 * ships every remaining line at once), so in practice this resolves to
 * unfulfilled/fulfilled/delivered — partially_fulfilled/partially_delivered
 * are modeled defensively for a future partial-shipment feature and are unit
 * tested directly (see status.test.ts) even though today's write path can't
 * produce them.
 */
export function deriveFulfillmentStatus(
  lines: Array<{ quantity: number; fulfilledQty: number; cancelledQty: number }>,
  fulfillments: Array<{ state: InternalFulfillmentState }>,
): OrderFulfillmentStatus {
  const total = lines.reduce((sum, l) => sum + Math.max(l.quantity - l.cancelledQty, 0), 0);
  const fulfilled = lines.reduce((sum, l) => sum + l.fulfilledQty, 0);
  if (total <= 0) return 'fulfilled'; // nothing left to fulfill (e.g. every line cancelled)
  if (fulfilled <= 0) return 'unfulfilled';
  if (fulfilled < total) return 'partially_fulfilled';
  const active = fulfillments.filter((f) => f.state !== 'Cancelled');
  if (active.length === 0) return 'fulfilled';
  const delivered = active.filter((f) => f.state === 'Delivered').length;
  if (delivered === active.length) return 'delivered';
  if (delivered > 0) return 'partially_delivered';
  return 'fulfilled';
}

/** Wire-facing rename for the individual `payment.state` field (distinct from
 *  the order-level `paymentStatus` above): `Settled` -> `captured`, and every
 *  other value lowercased, so a payment record never surfaces PascalCase on
 *  the wire either. BREAKING (pre-1.0) — see CHANGELOG.md. */
const PAYMENT_WIRE_STATE: Record<InternalPaymentState, string> = {
  Pending: 'pending',
  Authorized: 'authorized',
  Settled: 'captured',
  Declined: 'declined',
  Failed: 'failed',
};

export function wirePaymentState(state: string): string {
  return PAYMENT_WIRE_STATE[state as InternalPaymentState] ?? state.toLowerCase();
}
