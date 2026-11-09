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

/**
 * Per-order aggregates for the set-based admin counts: each child table is aggregated once per order (hash joins), not
 * once per order row as the correlated `orderTabSql`/status-sql projections do (perf/pg F1, EGM PG-2). Defines CTE `t`
 * with one row per order matching `where`: id, state, open_qty, open_pre, shipped, ordered_net and payment_status (the
 * `paymentStatusWithBalanceSql` value). tabs-sql.db.test.ts proves the counts built on it match the per-row forms, so a
 * change to one side must change the other.
 */
function orderAggregatesSql(where: SQL, scope: 'all' | 'tab-counts' = 'all'): SQL {
  // BP-M2 'tab-counts' scope: child aggregates are built only for orders whose rows can reach a tab count, so the
  // statement no longer aggregates trashed/demo orders (`where`) or orders that cannot contribute. Exactness argument,
  // per tab (aggregateTabSql): cancelled and refunded read `state` only; tofulfil, pre, partial, shipped read ol
  // aggregates and are false for every Cancelled order (each requires state <> 'Cancelled' or a Paid state); unpaid
  // reads payment_status, which is false for Cancelled (excluded by state) and is 'refunded' for Refunded without
  // reading payment/refund. `t` still lists EVERY order matching `where`, so `all` and the state-only tabs are
  // unchanged. The payment_status of a Cancelled order is therefore not meaningful in this scope: use it only for
  // the five aggregate tabs, never to expose a status (pendingFulfillmentCountSql and the list filter use scope 'all').
  const scoped = (alias: string, states: SQL): SQL => scope === 'tab-counts'
    ? sql`${sql.raw(alias)}.order_id in (select "order"."id" from "order" where ${where} and ${states})` : sql`true`;
  const olScope = scoped('ol', sql`"order"."state" <> 'Cancelled'`);
  const paymentScope = (alias: string) => scoped(alias, sql`"order"."state" not in ('Cancelled', 'Refunded')`);
  return sql`ol as (
      select ol.order_id,
        sum(greatest(ol.quantity - ol.fulfilled_qty - ol.cancelled_qty, 0))::int as open_qty,
        coalesce(sum(greatest(ol.quantity - ol.fulfilled_qty - ol.cancelled_qty, 0)) filter (where pv.is_pre_order), 0)::int as open_pre,
        sum(ol.fulfilled_qty)::int as shipped,
        sum(greatest(ol.quantity - ol.cancelled_qty, 0))::int as ordered_net
      from order_line ol left join product_variant pv on pv.id = ol.variant_id where ${olScope} group by ol.order_id),
    pay as (
      select p.order_id,
        sum(p.amount) filter (where ${usableTenderRawSql('p')}) as settled,
        bool_or(p.state = 'Settled') as any_settled, bool_or(p.state = 'Authorized') as any_auth,
        bool_or(p.state in ('Declined', 'Failed')) as any_failed,
        (array_agg(p.state order by p.created_at desc))[1] as latest
      from payment p where ${paymentScope('p')} group by p.order_id),
    ref as (
      select r.order_id, sum(r.amount) as edit_ref from refund r
      where r.state <> 'Failed' and r.metadata->>'source' = ${EDIT_REFUND_SOURCE} and ${paymentScope('r')} group by r.order_id),
    t as (
      select "order"."id" as id, "order"."state" as state, coalesce(ol.open_qty, 0) as open_qty, coalesce(ol.open_pre, 0) as open_pre,
        coalesce(ol.shipped, 0) as shipped, coalesce(ol.ordered_net, 0) as ordered_net,
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
      where ${where})`;
}

function tabCountsSql(opts: { excludeDemo: boolean }, scope: 'all' | 'tab-counts'): SQL {
  const live = opts.excludeDemo ? sql`"order"."deleted_at" is null and "order"."is_demo" = false` : sql`"order"."deleted_at" is null`;
  const counts = ORDER_TABS.map((t) => sql`(count(*) filter (where ${aggregateTabSql(t)}))::int as ${sql.identifier(t)}`);
  return sql`with ${orderAggregatesSql(live, scope)}
    select ${sql.join(counts, sql`, `)}, count(*)::int as "all" from t`;
}

/**
 * Tab counts for `GET /v1/admin/orders/tab-counts` in one set-based pass (~0.5 s -> ~80 ms on a 13.6k-order store).
 * BP-M2: child aggregates are scoped to the orders that can reach a count (see orderAggregatesSql, scope 'tab-counts');
 * every count is identical to `orderTabCountsSqlLegacy`, which tabs-sql.db.test.ts compares it with.
 */
export function orderTabCountsSql(opts: { excludeDemo: boolean }): SQL {
  return tabCountsSql(opts, 'tab-counts');
}

/** The pre-BP-M2 statement (ol/pay/ref aggregate every row of the store). Kept only as the reference the db test compares against. */
export function orderTabCountsSqlLegacy(opts: { excludeDemo: boolean }): SQL {
  return tabCountsSql(opts, 'all');
}

/**
 * The admin order list's `?tab=` filter (routes/admin.ts) as one set-based semi-join: the order ids whose aggregates
 * pass `aggregateTabSql`. Same rows as `orderTabSql(tab)`, which ran its correlated subqueries for every order before
 * the page's LIMIT, and again for the count (~135 ms per request on the default tab on dd). The 25-row page still
 * projects open/shipped quantities per row.
 */
export function orderTabFilterSql(tab: OrderTab): SQL {
  return sql`"order"."id" in (with ${orderAggregatesSql(sql`true`)} select id from t where ${aggregateTabSql(tab)})`;
}

/**
 * The dashboard's "pending fulfilment" KPI (`GET /v1/admin/dashboard`): live, non-demo, open or completed orders whose
 * payment status is `paid` and fulfilment status `unfulfilled` (`fulfillmentStatusSql`: units still ordered after
 * removals, none shipped). Set-based twin of that per-row predicate, which cost ~280 ms per dashboard load on dd.
 */
export function pendingFulfillmentCountSql(): SQL {
  return sql`with ${orderAggregatesSql(sql`"order"."deleted_at" is null and "order"."is_demo" = false and "order"."status" in ('open', 'completed')`)}
    select count(*)::int as n from t where payment_status = 'paid' and ordered_net > 0 and shipped <= 0`;
}

/** `orderTabSql` over the per-order aggregates of `orderAggregatesSql` (columns of `t`). */
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
