/**
 * G8: affiliate stats for an arbitrary date range with a per-SKU breakdown.
 *
 * Same commission rules as routes/admin-affiliate.ts::affiliateAmounts — paid /
 * partially refunded orders attributed to the affiliate's promotion, 10% of the
 * merchandise subtotal AFTER discounts (line_subtotal - line_discount per line,
 * which sums to subtotal - discount_total per order). An open range therefore
 * reconciles with the lifetime totals shown on the affiliate page.
 *
 * Totals commission is rounded once over the whole range (like the lifetime
 * figure); each SKU's commission is rounded on its own revenue, so the per-SKU
 * column can differ from the total by a few cents of rounding.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { dayRangeConditions, type DayRange } from '../lib/day-range.js';

export interface AffiliateSkuRow { sku: string; name: string; units: number; orders: number; revenue: number; commission: number }
export interface AffiliateRangeStats {
  range: { from: string | null; to: string | null };
  totals: { orders: number; units: number; revenue: number; commission: number };
  bySku: AffiliateSkuRow[];
}

export const commissionOf = (basisCents: number, pct: number): number => Math.round(basisCents * (pct / 100));

export async function affiliateRangeStats(
  tx: Tx,
  storeId: string,
  promotionId: string,
  range: DayRange,
  commissionPct: number,
): Promise<AffiliateRangeStats> {
  const date = sql`coalesce(o.placed_at, o.created_at)`;
  const where = sql.join([
    sql`o.store_id = ${storeId}`,
    sql`o.promotion_id = ${promotionId}`,
    sql`o.state = any(array['Paid','PartiallyRefunded']::order_state[])`,
    ...dayRangeConditions(date, range),
  ], sql` and `);

  const skuRes = await tx.execute(sql`
    select l.variant_sku as sku, max(l.variant_name) as name,
           sum(l.quantity)::int as units, count(distinct l.order_id)::int as orders,
           sum(l.line_subtotal - l.line_discount)::int as revenue
    from order_line l
    join "order" o on o.id = l.order_id
    where l.store_id = ${storeId} and ${where}
    group by l.variant_sku
    order by sum(l.line_subtotal - l.line_discount) desc, l.variant_sku`);
  const bySku = (skuRes.rows as Array<{ sku: string; name: string; units: number; orders: number; revenue: number }>)
    .map((r) => ({ ...r, commission: commissionOf(r.revenue, commissionPct) }));

  // Order-level totals come from the order rows themselves (not the line sums)
  // so an order with no surviving lines still counts, exactly like the lifetime
  // figure in affiliateAmounts.
  const totRes = await tx.execute(sql`
    select count(*)::int as orders,
           coalesce(sum(greatest(o.subtotal - o.discount_total, 0)), 0)::int as revenue
    from "order" o where ${where}`);
  const tot = (totRes.rows as Array<{ orders: number; revenue: number }>)[0] ?? { orders: 0, revenue: 0 };

  return {
    range: { from: range.from ?? null, to: range.to ?? null },
    totals: {
      orders: tot.orders,
      units: bySku.reduce((a, r) => a + r.units, 0),
      revenue: tot.revenue,
      commission: commissionOf(tot.revenue, commissionPct),
    },
    bySku,
  };
}
