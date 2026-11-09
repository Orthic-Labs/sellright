import { sql, type SQL } from 'drizzle-orm';

/**
 * Per-order commission basis in SQL (alias `o` = "order"): subtotal - discount_total - merchandise refunded, floored at 0.
 * Refunded merchandise = items_amount of Settled refunds. Order-edit refunds are excluded: the edit already lowered the
 * order's own totals, so counting them again would subtract twice. Twin of commissionBasis() in constants.ts.
 */
export const orderBasisSql: SQL = sql`greatest(o.subtotal - o.discount_total - coalesce((
  select sum(r.items_amount) from refund r
  where r.order_id = o.id and r.store_id = o.store_id and r.state = 'Settled'
    and coalesce(r.metadata->>'source', '') <> 'order_edit'), 0), 0)`;

/** Commission of one order's basis, rounded half up per order (twin of commissionOf() in constants.ts). */
export const commissionSql = (basis: SQL, pct: number): SQL => sql`floor((${basis}) * ${pct}::numeric / 100.0 + 0.5)`;
