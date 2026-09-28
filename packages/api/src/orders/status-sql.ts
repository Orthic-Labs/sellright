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
 * The outer `"order"` table reference is a hardcoded, fully-qualified raw
 * identifier (`"order"."id"`/`"order"."state"`), NOT a drizzle column proxy
 * (`s.order.id`). Drizzle only table-qualifies a column reference when the
 * enclosing top-level query has more than one table in its FROM/JOIN list —
 * a single-table `select(...).from(s.order)` renders `${s.order.id}` as the
 * bare identifier `"id"`. That bare identifier is fine at the OUTER level,
 * but every correlated subquery below also selects from a table with its own
 * `id` column (`payment`, `order_line`, `fulfillment` all have one) — inside
 * that subquery's scope, Postgres resolves the innermost `"id"` first, so an
 * unqualified reference silently binds to the SUBQUERY's own row instead of
 * the outer order, and `p.order_id = "id"` becomes `p.order_id = p.id`
 * (always false). That bug shipped once already — status.db.test.ts's SQL-
 * vs-TS parity cases caught it (every case needing an actual subquery match
 * fell back to the default value) — hence hardcoding the qualifier here
 * instead of trusting the call site's query shape to always disambiguate it.
 *
 * `status.db.test.ts` proves these agree with the TS functions row-for-row
 * against a range of seeded orders, so the duplication can't silently drift
 * — treat a failure there as "fix one of the two to match the other", never
 * "update the test".
 */
import { sql, type SQL } from 'drizzle-orm';

const orderId = sql.raw('"order"."id"');
const orderState = sql.raw('"order"."state"');

export function paymentStatusSql(): SQL<string> {
  return sql<string>`(case
    when ${orderState} = 'Refunded' then 'refunded'
    when ${orderState} = 'PartiallyRefunded' then 'partially_refunded'
    when ${orderState} = 'Paid' then 'paid'
    when ${orderState} = 'Cancelled' then (case
      when exists (select 1 from payment p where p.order_id = ${orderId} and p.state = 'Settled') then 'paid'
      when exists (select 1 from payment p where p.order_id = ${orderId} and p.state = 'Authorized') then 'voided'
      when exists (select 1 from payment p where p.order_id = ${orderId} and p.state in ('Declined', 'Failed')) then 'failed'
      else 'pending'
    end)
    else coalesce((
      select case p2.state
        when 'Authorized' then 'authorized'
        when 'Declined' then 'failed'
        when 'Failed' then 'failed'
        else 'pending'
      end
      from payment p2 where p2.order_id = ${orderId} order by p2.created_at desc limit 1
    ), 'pending')
  end)`;
}

export function fulfillmentStatusSql(): SQL<string> {
  return sql<string>`(case
    when (select coalesce(sum(greatest(ol.quantity - ol.cancelled_qty, 0)), 0) from order_line ol where ol.order_id = ${orderId}) <= 0 then 'fulfilled'
    when (select coalesce(sum(ol.fulfilled_qty), 0) from order_line ol where ol.order_id = ${orderId}) <= 0 then 'unfulfilled'
    when (select coalesce(sum(ol.fulfilled_qty), 0) from order_line ol where ol.order_id = ${orderId})
       < (select coalesce(sum(greatest(ol.quantity - ol.cancelled_qty, 0)), 0) from order_line ol where ol.order_id = ${orderId}) then 'partially_fulfilled'
    when not exists (select 1 from fulfillment f where f.order_id = ${orderId} and f.state <> 'Cancelled') then 'fulfilled'
    when exists (select 1 from fulfillment f where f.order_id = ${orderId} and f.state = 'Delivered')
         and exists (select 1 from fulfillment f where f.order_id = ${orderId} and f.state <> 'Cancelled' and f.state <> 'Delivered') then 'partially_delivered'
    when exists (select 1 from fulfillment f where f.order_id = ${orderId} and f.state <> 'Cancelled' and f.state <> 'Delivered') then 'fulfilled'
    else 'delivered'
  end)`;
}
