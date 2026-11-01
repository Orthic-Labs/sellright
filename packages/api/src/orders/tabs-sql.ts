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
import { usableTenderRawSql } from '../payments/tender.js';
import { EDIT_REFUND_SOURCE } from '../payments/edit-refund.js';
import { importedFinancialReconciliationPath } from '../import/source-compatibility.js';

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

/**
 * Tab counts for `GET /v1/admin/orders/tab-counts` in one set-based pass. `orderTabSql` evaluates its correlated
 * subqueries once per order row; counting every tab that way cost ~0.5 s on a 13.6k-order store (perf/pg F1). Here
 * each child table is aggregated once per order and the seven tabs filter those sums. Same rules as `orderTabSql` and
 * `paymentStatusWithBalanceSql`; tabs-sql.db.test.ts proves the counts match the per-row form, so a change to one side
 * must change the other.
 */
export function orderTabCountsSql(opts: { excludeDemo: boolean }): SQL {
  const live = opts.excludeDemo ? sql`"order"."deleted_at" is null and "order"."is_demo" = false` : sql`"order"."deleted_at" is null`;
  const counts = ORDER_TABS.map((t) => sql`(count(*) filter (where ${aggregateTabSql(t)}))::int as ${sql.identifier(t)}`);
  return sql`with ol as (
      select ol.order_id,
        sum(greatest(ol.quantity - ol.fulfilled_qty - ol.cancelled_qty, 0))::int as open_qty,
        coalesce(sum(greatest(ol.quantity - ol.fulfilled_qty - ol.cancelled_qty, 0)) filter (where pv.is_pre_order), 0)::int as open_pre,
        sum(ol.fulfilled_qty)::int as shipped
      from order_line ol left join product_variant pv on pv.id = ol.variant_id group by ol.order_id),
    pay as (
      select p.order_id,
        sum(p.amount) filter (where ${usableTenderRawSql('p')}) as settled,
        bool_or(p.state = 'Settled') as any_settled, bool_or(p.state = 'Authorized') as any_auth,
        bool_or(p.state in ('Declined', 'Failed')) as any_failed,
        (array_agg(p.state order by p.created_at desc))[1] as latest
      from payment p group by p.order_id),
    ref as (
      select r.order_id, sum(r.amount) as edit_ref from refund r
      where r.state <> 'Failed' and r.metadata->>'source' = ${EDIT_REFUND_SOURCE} group by r.order_id),
    t as (
      select "order"."state" as state, coalesce(ol.open_qty, 0) as open_qty, coalesce(ol.open_pre, 0) as open_pre, coalesce(ol.shipped, 0) as shipped,
        -- Nested CASE: the TOASTed metadata is read only for a paid order that still owes money.
        case when "order"."state" in ('Paid', 'PartiallyRefunded')
               and ("order"."grand_total" - coalesce(pay.settled, 0) + coalesce(ref.edit_ref, 0)) > 0
               and case when ("order"."metadata" #> ARRAY[${importedFinancialReconciliationPath[0]}, ${importedFinancialReconciliationPath[1]}]::text[]) IS NULL then true else false end
             then 'balance_due'
             when "order"."state" = 'Refunded' then 'refunded'
             when "order"."state" = 'PartiallyRefunded' then 'partially_refunded'
             when "order"."state" = 'Paid' then 'paid'
             when "order"."state" = 'Cancelled' then (case when pay.any_settled then 'paid' when pay.any_auth then 'voided' when pay.any_failed then 'failed' else 'pending' end)
             else (case pay.latest when 'Authorized' then 'authorized' when 'Declined' then 'failed' when 'Failed' then 'failed' else 'pending' end)
        end as payment_status
      from "order" left join ol on ol.order_id = "order"."id" left join pay on pay.order_id = "order"."id" left join ref on ref.order_id = "order"."id"
      where ${live})
    select ${sql.join(counts, sql`, `)}, count(*)::int as "all" from t`;
}

/** `orderTabSql` over the per-order aggregates of `orderTabCountsSql` (columns of `t`). */
function aggregateTabSql(tab: OrderTab): SQL {
  const paid = sql`state in ('Paid', 'PartiallyRefunded')`;
  switch (tab) {
    case 'tofulfil': return sql`(${paid} and open_qty - open_pre > 0)`;
    case 'pre': return sql`(state <> 'Cancelled' and open_pre > 0)`;
    case 'partial': return sql`(${paid} and shipped > 0 and open_qty > 0)`;
    case 'unpaid': return sql`(state <> 'Cancelled' and payment_status in ('pending', 'authorized', 'balance_due'))`;
    case 'shipped': return sql`(state <> 'Cancelled' and shipped > 0 and open_qty = 0)`;
    case 'refunded': return sql`(state in ('Refunded', 'PartiallyRefunded'))`;
    case 'cancelled': return sql`(state = 'Cancelled')`;
  }
}
