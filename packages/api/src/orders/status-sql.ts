/**
 * SQL projections of `derivePaymentStatus`/`deriveFulfillmentStatus`
 * (orders/status.ts), for the ONE place that genuinely needs them in SQL: the
 * admin order list's `?paymentStatus=`/`?fulfillmentStatus=` filters, where
 * pagination + an accurate total count require the predicate to run in the
 * database, not after a page has already been sliced out in application
 * code. Every other order-status read (admin detail, account list/detail,
 * public receipt, guest tracking) uses the TS functions directly — this file
 * exists ONLY for admin.ts's list filters.
 *
 * `status-sql.db.test.ts` proves these agree with the TS functions row-for-
 * row against a range of seeded orders, so the duplication can't silently
 * drift — treat a failure there as "fix one of the two to match the other",
 * never "update the test".
 */
import { sql, type SQL } from 'drizzle-orm';
import * as s from '../db/schema.js';

export function paymentStatusSql(order: typeof s.order = s.order): SQL<string> {
  return sql<string>`(case
    when ${order.state} = 'Refunded' then 'refunded'
    when ${order.state} = 'PartiallyRefunded' then 'partially_refunded'
    when ${order.state} = 'Paid' then 'paid'
    when ${order.state} = 'Cancelled' then (case
      when exists (select 1 from payment p where p.order_id = ${order.id} and p.state = 'Settled') then 'paid'
      when exists (select 1 from payment p where p.order_id = ${order.id} and p.state = 'Authorized') then 'voided'
      when exists (select 1 from payment p where p.order_id = ${order.id} and p.state in ('Declined', 'Failed')) then 'failed'
      else 'pending'
    end)
    else coalesce((
      select case p2.state
        when 'Authorized' then 'authorized'
        when 'Declined' then 'failed'
        when 'Failed' then 'failed'
        else 'pending'
      end
      from payment p2 where p2.order_id = ${order.id} order by p2.created_at desc limit 1
    ), 'pending')
  end)`;
}

export function fulfillmentStatusSql(order: typeof s.order = s.order): SQL<string> {
  return sql<string>`(case
    when (select coalesce(sum(greatest(ol.quantity - ol.cancelled_qty, 0)), 0) from order_line ol where ol.order_id = ${order.id}) <= 0 then 'fulfilled'
    when (select coalesce(sum(ol.fulfilled_qty), 0) from order_line ol where ol.order_id = ${order.id}) <= 0 then 'unfulfilled'
    when (select coalesce(sum(ol.fulfilled_qty), 0) from order_line ol where ol.order_id = ${order.id})
       < (select coalesce(sum(greatest(ol.quantity - ol.cancelled_qty, 0)), 0) from order_line ol where ol.order_id = ${order.id}) then 'partially_fulfilled'
    when not exists (select 1 from fulfillment f where f.order_id = ${order.id} and f.state <> 'Cancelled') then 'fulfilled'
    when exists (select 1 from fulfillment f where f.order_id = ${order.id} and f.state = 'Delivered')
         and exists (select 1 from fulfillment f where f.order_id = ${order.id} and f.state <> 'Cancelled' and f.state <> 'Delivered') then 'partially_delivered'
    when exists (select 1 from fulfillment f where f.order_id = ${order.id} and f.state <> 'Cancelled' and f.state <> 'Delivered') then 'fulfilled'
    else 'delivered'
  end)`;
}
