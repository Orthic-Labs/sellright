/**
 * #406 admin order tabs. One predicate per tab, shared by the list filter
 * (`GET /v1/admin/orders?tab=`) and the counts endpoint, so a tab's count is
 * always the number of rows the tab shows. Quantities follow the same rules as
 * fulfillmentStatusSql: units refunded before shipping sit in cancelled_qty
 * ("removed") and are never counted as shipped.
 *
 * Same qualifier caveat as status-sql.ts: the outer order is referenced as the
 * raw `"order"."id"` so correlated subqueries never bind to their own `id`.
 */
import { sql, type SQL } from 'drizzle-orm';
import { paymentStatusWithBalanceSql } from './status-sql.js';

export const ORDER_TABS = ['tofulfil', 'pre', 'partial', 'unpaid', 'shipped', 'refunded', 'cancelled'] as const;
export type OrderTab = (typeof ORDER_TABS)[number];

const orderId = sql.raw('"order"."id"');
const orderState = sql.raw('"order"."state"');

/** Units still to ship: ordered less shipped less removed. */
export function openQtySql(): SQL<number> {
  return sql<number>`(select coalesce(sum(greatest(ol.quantity - ol.fulfilled_qty - ol.cancelled_qty, 0)), 0)::int from order_line ol where ol.order_id = ${orderId})`;
}
/** Units still to ship whose variant is on pre-order. */
export function openPreOrderQtySql(): SQL<number> {
  return sql<number>`(select coalesce(sum(greatest(ol.quantity - ol.fulfilled_qty - ol.cancelled_qty, 0)), 0)::int from order_line ol
    join product_variant pv on pv.id = ol.variant_id where ol.order_id = ${orderId} and pv.is_pre_order)`;
}
export function shippedQtySql(): SQL<number> {
  return sql<number>`(select coalesce(sum(ol.fulfilled_qty), 0)::int from order_line ol where ol.order_id = ${orderId})`;
}

/** Units removed before shipping (refunded or cancelled off the order). */
export function removedQtySql(): SQL<number> {
  return sql<number>`(select coalesce(sum(ol.cancelled_qty), 0)::int from order_line ol where ol.order_id = ${orderId})`;
}

const PAID = sql`${orderState} in ('Paid', 'PartiallyRefunded')`;

export function orderTabSql(tab: OrderTab): SQL {
  switch (tab) {
    case 'tofulfil': return sql`(${PAID} and ${openQtySql()} - ${openPreOrderQtySql()} > 0)`;
    case 'pre': return sql`(${orderState} <> 'Cancelled' and ${openPreOrderQtySql()} > 0)`;
    case 'partial': return sql`(${PAID} and ${shippedQtySql()} > 0 and ${openQtySql()} > 0)`;
    case 'unpaid': return sql`(${orderState} <> 'Cancelled' and ${paymentStatusWithBalanceSql()} in ('pending', 'authorized', 'balance_due'))`;
    case 'shipped': return sql`(${orderState} <> 'Cancelled' and ${shippedQtySql()} > 0 and ${openQtySql()} = 0)`;
    case 'refunded': return sql`(${orderState} in ('Refunded', 'PartiallyRefunded'))`;
    case 'cancelled': return sql`(${orderState} = 'Cancelled')`;
  }
}
