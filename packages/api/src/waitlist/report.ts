/**
 * G10: waitlist demand report — how many shoppers are waiting for each variant
 * / product to come back in stock, and how many were already told.
 *
 * Two signup lanes feed the same restock notifier (routes/restock.ts) and both
 * are counted here so the report matches reality:
 *   - restock_request (one-shot "notify me"): pending | notified | canceled
 *   - subscriber rows kind='waitlist', topic 'restock:<variantId>' (legacy /
 *     imported waitlists): confirmed -> pending, unconfirmed (never
 *     double-opted-in) -> unconfirmed, unsubscribed/bounced -> legacyClosed
 *     (the notifier consumes a row by flipping it to 'unsubscribed', so a
 *     notified legacy row and a manually unsubscribed one are indistinguishable).
 *
 * No emails leave this module: the report is aggregate only.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { dayRangeConditions, type DayRange } from '../lib/day-range.js';

export const WAITLIST_ROW_CAP = 5000;

export interface WaitlistRow {
  /** Variant id (variant grouping) or the product key (product grouping). */
  key: string;
  productName: string;
  productSlug: string | null;
  /** null when grouped by product. */
  variantName: string | null;
  sku: string | null;
  /** Units currently purchasable (on hand - allocated); summed across variants when grouped by product. null = no stock row / variant gone. */
  available: number | null;
  variants: number;
  pending: number;
  notified: number;
  canceled: number;
  unconfirmed: number;
  legacyClosed: number;
  total: number;
  lastSignupAt: string | null;
  oldestPendingAt: string | null;
}

export type WaitlistSort = 'pending' | 'total' | 'notified' | 'canceled' | 'product' | 'variant' | 'available' | 'lastSignup' | 'oldestPending';
export const WAITLIST_SORTS: readonly WaitlistSort[] = ['pending', 'total', 'notified', 'canceled', 'product', 'variant', 'available', 'lastSignup', 'oldestPending'];
export type WaitlistGroup = 'variant' | 'product';

export interface WaitlistReport {
  groupBy: WaitlistGroup;
  range: { from: string | null; to: string | null };
  summary: { pending: number; notified: number; canceled: number; unconfirmed: number; legacyClosed: number; total: number; products: number; variants: number };
  rows: WaitlistRow[];
  truncated: boolean;
}

/** Internal per-variant row; productKey groups variants of one product. */
export type VariantDemandRow = WaitlistRow & { productKey: string };

interface VariantAgg {
  variant_id: string; product_key: string; product_name: string; product_slug: string | null; variant_name: string; sku: string | null;
  available: number | null; pending: number; notified: number; canceled: number; unconfirmed: number; legacy_closed: number; total: number;
  last_signup_at: Date | string | null; oldest_pending_at: Date | string | null;
}

const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());
const maxIso = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : a ?? b);
const minIso = (a: string | null, b: string | null) => (a && b ? (a < b ? a : b) : a ?? b);

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** One row per variant that has at least one signup in the range. */
export async function loadVariantDemand(tx: Tx, storeId: string, range: DayRange): Promise<{ rows: VariantDemandRow[]; truncated: boolean }> {
  const reqRange = dayRangeConditions(sql`r.created_at`, range);
  const subRange = dayRangeConditions(sql`sub.created_at`, range);
  const reqWhere = sql.join([sql`r.store_id = ${storeId}`, ...reqRange], sql` and `);
  const subWhere = sql.join([sql`sub.store_id = ${storeId}`, sql`sub.kind = 'waitlist'`, sql`sub.topic like 'restock:%'`, ...subRange], sql` and `);
  const topicRe = `^restock:${UUID}$`;

  const res = await tx.execute(sql`
    with lane as (
      select r.variant_id, r.status as bucket, r.created_at, r.product_name, r.variant_name, r.product_slug
      from restock_request r where ${reqWhere}
      union all
      select case when sub.topic ~ ${topicRe} then substr(sub.topic, 9)::uuid end as variant_id,
             case sub.status when 'confirmed' then 'pending' when 'pending' then 'unconfirmed' else 'legacy_closed' end as bucket,
             sub.created_at, null::text, null::text, null::text
      from subscriber sub where ${subWhere}
    )
    select l.variant_id,
           coalesce(pv.product_id::text, max(l.product_slug), l.variant_id::text) as product_key,
           coalesce(max(p.name), max(l.product_name), 'Unknown product') as product_name,
           coalesce(max(p.slug), max(l.product_slug)) as product_slug,
           coalesce(max(pv.name), max(l.variant_name), 'Unknown variant') as variant_name,
           max(pv.sku) as sku,
           (case when max(stk.variant_id::text) is null then null else max(stk.on_hand) - max(stk.allocated) end)::int as available,
           (count(*) filter (where l.bucket = 'pending'))::int as pending,
           (count(*) filter (where l.bucket = 'notified'))::int as notified,
           (count(*) filter (where l.bucket = 'canceled'))::int as canceled,
           (count(*) filter (where l.bucket = 'unconfirmed'))::int as unconfirmed,
           (count(*) filter (where l.bucket = 'legacy_closed'))::int as legacy_closed,
           count(*)::int as total,
           max(l.created_at) as last_signup_at,
           min(l.created_at) filter (where l.bucket = 'pending') as oldest_pending_at
    from lane l
    left join product_variant pv on pv.id = l.variant_id and pv.store_id = ${storeId}
    left join product p on p.id = pv.product_id and p.store_id = ${storeId}
    left join stock stk on stk.variant_id = pv.id and stk.store_id = ${storeId}
    where l.variant_id is not null
    group by l.variant_id, pv.product_id
    order by count(*) filter (where l.bucket = 'pending') desc, count(*) desc, l.variant_id
    limit ${WAITLIST_ROW_CAP + 1}`);

  const raw = res.rows as unknown as VariantAgg[];
  const truncated = raw.length > WAITLIST_ROW_CAP;
  const rows = raw.slice(0, WAITLIST_ROW_CAP).map((r): VariantDemandRow => ({
    key: r.variant_id, productName: r.product_name, productSlug: r.product_slug, variantName: r.variant_name, sku: r.sku,
    available: r.available, variants: 1,
    pending: r.pending, notified: r.notified, canceled: r.canceled, unconfirmed: r.unconfirmed, legacyClosed: r.legacy_closed, total: r.total,
    lastSignupAt: iso(r.last_signup_at), oldestPendingAt: iso(r.oldest_pending_at),
    productKey: r.product_key,
  }));
  return { rows, truncated };
}

/** Fold variant rows into one row per product (pure). */
export function groupByProduct(variantRows: VariantDemandRow[]): WaitlistRow[] {
  const byProduct = new Map<string, WaitlistRow>();
  for (const { productKey: pk, ...v } of variantRows) {
    const cur = byProduct.get(pk);
    if (!cur) {
      byProduct.set(pk, { ...v, key: pk, variantName: null, sku: null });
      continue;
    }
    cur.variants += v.variants;
    cur.available = cur.available == null && v.available == null ? null : (cur.available ?? 0) + (v.available ?? 0);
    cur.pending += v.pending; cur.notified += v.notified; cur.canceled += v.canceled;
    cur.unconfirmed += v.unconfirmed; cur.legacyClosed += v.legacyClosed; cur.total += v.total;
    cur.lastSignupAt = maxIso(cur.lastSignupAt, v.lastSignupAt);
    cur.oldestPendingAt = minIso(cur.oldestPendingAt, v.oldestPendingAt);
  }
  return [...byProduct.values()];
}

const cmpStr = (a: string | null, b: string | null) => (a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'base' });
/** Nulls always sort last regardless of direction. */
function cmpNullable<T>(a: T | null, b: T | null, dir: 1 | -1, cmp: (x: T, y: T) => number): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return cmp(a, b) * dir;
}

/** Stable sort by a whitelisted key (pure). Ties fall back to total signups (desc), then product and variant name. */
export function sortWaitlist(rows: WaitlistRow[], sort: WaitlistSort, dir: 'asc' | 'desc'): WaitlistRow[] {
  const d: 1 | -1 = dir === 'asc' ? 1 : -1;
  const num = (x: number, y: number) => x - y;
  const primary = (a: WaitlistRow, b: WaitlistRow): number => {
    switch (sort) {
      case 'pending': return (a.pending - b.pending) * d;
      case 'total': return (a.total - b.total) * d;
      case 'notified': return (a.notified - b.notified) * d;
      case 'canceled': return (a.canceled - b.canceled) * d;
      case 'product': return cmpStr(a.productName, b.productName) * d;
      case 'variant': return cmpNullable(a.variantName, b.variantName, d, cmpStr);
      case 'available': return cmpNullable(a.available, b.available, d, num);
      case 'lastSignup': return cmpNullable(a.lastSignupAt, b.lastSignupAt, d, cmpStr);
      case 'oldestPending': return cmpNullable(a.oldestPendingAt, b.oldestPendingAt, d, cmpStr);
    }
  };
  return [...rows].sort((a, b) => primary(a, b) || b.total - a.total || cmpStr(a.productName, b.productName) || cmpStr(a.variantName, b.variantName) || a.key.localeCompare(b.key));
}

export function summarize(variantRows: VariantDemandRow[]): WaitlistReport['summary'] {
  const sum = (f: (r: WaitlistRow) => number) => variantRows.reduce((a, r) => a + f(r), 0);
  return {
    pending: sum((r) => r.pending), notified: sum((r) => r.notified), canceled: sum((r) => r.canceled),
    unconfirmed: sum((r) => r.unconfirmed), legacyClosed: sum((r) => r.legacyClosed), total: sum((r) => r.total),
    variants: variantRows.length,
    products: new Set(variantRows.map((r) => r.productKey)).size,
  };
}

export async function waitlistReport(
  tx: Tx, storeId: string,
  opts: { range: DayRange; groupBy: WaitlistGroup; sort: WaitlistSort; dir: 'asc' | 'desc' },
): Promise<WaitlistReport> {
  const { rows: variantRows, truncated } = await loadVariantDemand(tx, storeId, opts.range);
  const grouped = opts.groupBy === 'product' ? groupByProduct(variantRows) : variantRows.map(({ productKey: _pk, ...r }) => r);
  const rows = sortWaitlist(grouped, opts.sort, opts.dir);
  return { groupBy: opts.groupBy, range: { from: opts.range.from ?? null, to: opts.range.to ?? null }, summary: summarize(variantRows), rows, truncated };
}

// ── CSV ─────────────────────────────────────────────────────────────────────
const csvCell = (v: unknown): string => {
  let x = v == null ? '' : String(v);
  // Spreadsheet formula-injection guard: product names are merchant-typed free text.
  if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`;
  return /[",\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
};

export function waitlistCsv(report: WaitlistReport): string {
  const productMode = report.groupBy === 'product';
  const header = productMode
    ? ['Product', 'Variants', 'Waiting now', 'Notified', 'Canceled', 'Unconfirmed', 'Legacy closed', 'Total signups', 'In stock now', 'Oldest waiting', 'Latest signup']
    : ['Product', 'Variant', 'SKU', 'Waiting now', 'Notified', 'Canceled', 'Unconfirmed', 'Legacy closed', 'Total signups', 'In stock now', 'Oldest waiting', 'Latest signup'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of report.rows) {
    const common = [r.pending, r.notified, r.canceled, r.unconfirmed, r.legacyClosed, r.total, r.available ?? '', r.oldestPendingAt ?? '', r.lastSignupAt ?? ''];
    const lead = productMode ? [r.productName, r.variants] : [r.productName, r.variantName, r.sku];
    lines.push([...lead, ...common].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
