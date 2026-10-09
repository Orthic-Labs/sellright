/**
 * Order export — filters, column catalog and row fetch shared by the CSV and
 * XLSX routes (admin-order-ops.ts). One query serves both formats; `rows=line`
 * switches from one row per order to one row per order line.
 *
 * Status filters use the wire-facing three-way split (orders/status.ts +
 * status-sql.ts), never the internal order state — except the legacy `state`
 * param kept for existing callers.
 */
import { sql, type SQL } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { paymentStatusWithBalanceSql, fulfillmentStatusSql } from './status-sql.js';
import { ORDER_STATUS_VALUES, ORDER_PAYMENT_FILTER_VALUES, ORDER_FULFILLMENT_STATUS_VALUES } from './status.js';

export const EXPORT_ROW_CAP = 50_000;

export type ExportFilters = {
  /** Inclusive YYYY-MM-DD bounds (UTC) on the order date (placed, else created). */
  from?: string; to?: string;
  /** Rolling window in days; only used when neither from nor to is given. */
  days: number;
  /** Legacy internal order state (PendingPayment | Paid | ...). */
  state?: string;
  status?: string; paymentStatus?: string; fulfillmentStatus?: string;
  preOrder?: boolean; trashed?: boolean;
  paymentMethod?: string; /** shipping_method_code */ shippingMethod?: string; country?: string; coupon?: string; q?: string;
};

export type ExportMode = 'order' | 'line';

type ExportRow = {
  code: string; placed_at: Date | null; created_at: Date; email: string | null; customer_name: string | null;
  state: string; status: string; payment_status: string; fulfillment_status: string;
  is_pre_order: boolean; tracking: string | null; fulfillment_state: string | null;
  subtotal: number; discount_total: number; shipping_total: number; tax_total: number; grand_total: number; currency: string;
  payment_method: string | null; shipping_method_name: string | null; shipping_method_code: string | null; coupon: string | null;
  ship_name: string | null; ship_line1: string | null; ship_line2: string | null; ship_city: string | null;
  ship_region: string | null; ship_postal: string | null; ship_country: string | null; ship_phone: string | null;
  line_sku: string | null; line_name: string | null; line_qty: number | null; line_unit: number | null; line_total: number | null; line_discount: number | null;
};

type Cell = string | number;
type Col = { key: string; label: string; group: 'Order' | 'Customer' | 'Status' | 'Money' | 'Shipping' | 'Line item'; lineOnly?: boolean; money?: boolean; get: (r: ExportRow) => Cell };

const cents = (n: number | null) => (n ?? 0) / 100;
const date10 = (r: ExportRow) => new Date(r.placed_at ?? r.created_at).toISOString().slice(0, 10);

export const EXPORT_COLUMNS: Col[] = [
  { key: 'code', label: 'Order', group: 'Order', get: (r) => r.code },
  { key: 'date', label: 'Date', group: 'Order', get: date10 },
  { key: 'email', label: 'Email', group: 'Customer', get: (r) => r.email ?? '' },
  { key: 'customerName', label: 'Customer name', group: 'Customer', get: (r) => r.customer_name ?? '' },
  { key: 'state', label: 'Internal state', group: 'Status', get: (r) => r.state },
  { key: 'paymentStatus', label: 'Payment status', group: 'Status', get: (r) => r.payment_status },
  { key: 'fulfillmentStatus', label: 'Fulfillment status', group: 'Status', get: (r) => r.fulfillment_status },
  { key: 'orderStatus', label: 'Order status', group: 'Status', get: (r) => r.status },
  { key: 'preOrder', label: 'Pre-order', group: 'Order', get: (r) => (r.is_pre_order ? 'yes' : '') },
  { key: 'fulfillment', label: 'Latest fulfillment state', group: 'Status', get: (r) => r.fulfillment_state ?? '' },
  { key: 'tracking', label: 'Tracking', group: 'Shipping', get: (r) => r.tracking ?? '' },
  { key: 'paymentMethod', label: 'Payment method', group: 'Order', get: (r) => r.payment_method ?? '' },
  { key: 'shippingMethod', label: 'Shipping method', group: 'Shipping', get: (r) => r.shipping_method_name ?? r.shipping_method_code ?? '' },
  { key: 'coupon', label: 'Coupon', group: 'Order', get: (r) => r.coupon ?? '' },
  { key: 'subtotal', label: 'Subtotal', group: 'Money', money: true, get: (r) => cents(r.subtotal) },
  { key: 'discount', label: 'Discount', group: 'Money', money: true, get: (r) => cents(r.discount_total) },
  { key: 'shipping', label: 'Shipping', group: 'Money', money: true, get: (r) => cents(r.shipping_total) },
  { key: 'tax', label: 'Tax', group: 'Money', money: true, get: (r) => cents(r.tax_total) },
  { key: 'total', label: 'Total', group: 'Money', money: true, get: (r) => cents(r.grand_total) },
  { key: 'currency', label: 'Currency', group: 'Money', get: (r) => r.currency },
  { key: 'shipName', label: 'Ship to name', group: 'Shipping', get: (r) => r.ship_name ?? '' },
  { key: 'shipLine1', label: 'Ship to address 1', group: 'Shipping', get: (r) => r.ship_line1 ?? '' },
  { key: 'shipLine2', label: 'Ship to address 2', group: 'Shipping', get: (r) => r.ship_line2 ?? '' },
  { key: 'shipCity', label: 'Ship to city', group: 'Shipping', get: (r) => r.ship_city ?? '' },
  { key: 'shipRegion', label: 'Ship to state/region', group: 'Shipping', get: (r) => r.ship_region ?? '' },
  { key: 'shipPostal', label: 'Ship to postal code', group: 'Shipping', get: (r) => r.ship_postal ?? '' },
  { key: 'country', label: 'Ship to country', group: 'Shipping', get: (r) => r.ship_country ?? '' },
  { key: 'phone', label: 'Ship to phone', group: 'Shipping', get: (r) => r.ship_phone ?? '' },
  { key: 'sku', label: 'SKU', group: 'Line item', lineOnly: true, get: (r) => r.line_sku ?? '' },
  { key: 'item', label: 'Item', group: 'Line item', lineOnly: true, get: (r) => r.line_name ?? '' },
  { key: 'quantity', label: 'Quantity', group: 'Line item', lineOnly: true, get: (r) => r.line_qty ?? 0 },
  { key: 'unitPrice', label: 'Unit price', group: 'Line item', money: true, lineOnly: true, get: (r) => cents(r.line_unit) },
  { key: 'lineDiscount', label: 'Line discount', group: 'Line item', money: true, lineOnly: true, get: (r) => cents(r.line_discount) },
  { key: 'lineTotal', label: 'Line total', group: 'Line item', money: true, lineOnly: true, get: (r) => cents(r.line_total) },
];

/** Back-compat default column set (the original fixed export). */
export const DEFAULT_EXPORT_COLUMNS = ['code', 'date', 'email', 'state', 'preOrder', 'fulfillment', 'tracking', 'subtotal', 'discount', 'shipping', 'tax', 'total', 'currency'] as const;
export const DEFAULT_LINE_COLUMNS = ['sku', 'item', 'quantity', 'unitPrice', 'lineTotal'] as const;

const BY_KEY = new Map(EXPORT_COLUMNS.map((c) => [c.key, c]));

/** Resolve a requested column list; unknown keys are dropped, order is preserved. */
export function resolveExportColumns(requested: string[] | undefined, mode: ExportMode): Col[] {
  const keys = (requested ?? []).filter((k, i, a) => BY_KEY.has(k) && a.indexOf(k) === i);
  const chosen = keys.length ? keys : [...DEFAULT_EXPORT_COLUMNS];
  let cols = chosen.map((k) => BY_KEY.get(k)!);
  if (mode === 'order') cols = cols.filter((c) => !c.lineOnly);
  else if (!cols.some((c) => c.lineOnly)) cols = [...cols, ...DEFAULT_LINE_COLUMNS.map((k) => BY_KEY.get(k)!)];
  return cols.length ? cols : DEFAULT_EXPORT_COLUMNS.map((k) => BY_KEY.get(k)!);
}

export const exportColumnCatalog = () => EXPORT_COLUMNS.map(({ key, label, group, lineOnly }) => ({ key, label, group, lineOnly: !!lineOnly }));

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: string | undefined) => (v && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : undefined);
const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined => (v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);

export function parseExportFilters(get: (k: string) => string | undefined): ExportFilters {
  const flag = (k: string) => { const v = get(k); return v === '1' || v === 'true'; };
  return {
    from: validDay(get('from')), to: validDay(get('to')),
    days: Math.min(3650, Math.max(1, Number(get('days') ?? '365') || 365)),
    state: get('state') || undefined,
    status: oneOf(get('status'), [...ORDER_STATUS_VALUES, 'active'] as const),
    paymentStatus: oneOf(get('paymentStatus'), ORDER_PAYMENT_FILTER_VALUES),
    fulfillmentStatus: oneOf(get('fulfillmentStatus'), ORDER_FULFILLMENT_STATUS_VALUES),
    preOrder: flag('preOrder') || undefined,
    trashed: flag('trashed') || undefined,
    paymentMethod: get('paymentMethod')?.trim() || undefined,
    shippingMethod: get('shippingMethod')?.trim() || undefined,
    country: get('country')?.trim().toUpperCase() || undefined,
    coupon: get('coupon')?.trim() || undefined,
    q: get('q')?.trim() || undefined,
  };
}

export function parseExportMode(v: string | undefined): ExportMode { return v === 'line' ? 'line' : 'order'; }
export function parseExportColumnList(v: string | undefined): string[] | undefined {
  const l = (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return l.length ? l : undefined;
}

/** WHERE conditions for an export (also unit-tested for shape). */
export function exportConditions(f: ExportFilters): SQL[] {
  const date = sql`coalesce("order"."placed_at", "order"."created_at")`;
  const c: SQL[] = [f.trashed ? sql`"order"."deleted_at" is not null` : sql`"order"."deleted_at" is null`];
  if (f.from || f.to) {
    if (f.from) c.push(sql`${date} >= ${`${f.from}T00:00:00Z`}::timestamptz`);
    if (f.to) c.push(sql`${date} < (${`${f.to}T00:00:00Z`}::timestamptz + interval '1 day')`);
  } else {
    c.push(sql`${date} >= now() - (${f.days} || ' days')::interval`);
  }
  if (f.state) c.push(sql`"order"."state" = ${f.state}`);
  // 'active' = open + completed (the owner-facing "Open"); matches the list endpoint.
  if (f.status === 'active') c.push(sql`"order"."status" in ('open', 'completed')`);
  else if (f.status) c.push(sql`"order"."status" = ${f.status}`);
  if (f.paymentStatus) c.push(sql`${paymentStatusWithBalanceSql()} = ${f.paymentStatus}`);
  if (f.fulfillmentStatus) c.push(sql`${fulfillmentStatusSql()} = ${f.fulfillmentStatus}`);
  if (f.preOrder) c.push(sql`"order"."is_pre_order" = true`);
  if (f.paymentMethod) c.push(sql`exists (select 1 from payment pm where pm.order_id = "order"."id" and lower(pm.method) = ${f.paymentMethod.toLowerCase()})`);
  if (f.shippingMethod) c.push(f.shippingMethod === '__none__' ? sql`"order"."shipping_method_code" is null` : sql`"order"."shipping_method_code" = ${f.shippingMethod}`);
  if (f.country) c.push(sql`upper("order"."shipping_address"->>'country') = ${f.country}`);
  if (f.coupon) c.push(sql`lower(promo.code) = ${f.coupon.toLowerCase()}`);
  if (f.q) c.push(sql`("order"."code" ilike ${`%${f.q}%`} or cust.email ilike ${`%${f.q}%`})`);
  return c;
}

export async function fetchExportRows(storeId: string, f: ExportFilters, mode: ExportMode): Promise<ExportRow[]> {
  const where = sql.join(exportConditions(f), sql` and `);
  const lineSelect = mode === 'line'
    ? sql`ol.variant_sku as line_sku, ol.variant_name as line_name, ol.quantity as line_qty, ol.unit_price as line_unit, ol.line_total as line_total, ol.line_discount as line_discount`
    : sql`null::text as line_sku, null::text as line_name, null::int as line_qty, null::int as line_unit, null::int as line_total, null::int as line_discount`;
  const lineJoin = mode === 'line' ? sql`join order_line ol on ol.order_id = "order"."id"` : sql``;
  const lineOrder = mode === 'line' ? sql`, ol.id` : sql``;
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`
      select "order"."code" as code, "order"."placed_at" as placed_at, "order"."created_at" as created_at,
        cust.email as email, nullif(trim(coalesce(cust.first_name, '') || ' ' || coalesce(cust.last_name, '')), '') as customer_name,
        "order"."state"::text as state, "order"."status" as status,
        ${paymentStatusWithBalanceSql()} as payment_status, ${fulfillmentStatusSql()} as fulfillment_status,
        "order"."is_pre_order" as is_pre_order,
        (select f.tracking_code from fulfillment f where f.order_id = "order"."id" order by f.created_at desc limit 1) as tracking,
        (select f.state::text from fulfillment f where f.order_id = "order"."id" order by f.created_at desc limit 1) as fulfillment_state,
        "order"."subtotal" as subtotal, "order"."discount_total" as discount_total, "order"."shipping_total" as shipping_total,
        "order"."tax_total" as tax_total, "order"."grand_total" as grand_total, "order"."currency" as currency,
        (select pm.method from payment pm where pm.order_id = "order"."id" order by (pm.state = 'Settled') desc, pm.created_at desc limit 1) as payment_method,
        "order"."shipping_method_name" as shipping_method_name, "order"."shipping_method_code" as shipping_method_code,
        promo.code as coupon,
        "order"."shipping_address"->>'fullName' as ship_name, "order"."shipping_address"->>'line1' as ship_line1,
        "order"."shipping_address"->>'line2' as ship_line2, "order"."shipping_address"->>'city' as ship_city,
        "order"."shipping_address"->>'province' as ship_region, "order"."shipping_address"->>'postalCode' as ship_postal,
        "order"."shipping_address"->>'country' as ship_country, "order"."shipping_address"->>'phone' as ship_phone,
        ${lineSelect}
      from "order"
      left join customer cust on cust.id = "order"."customer_id"
      left join promotion promo on promo.id = "order"."promotion_id"
      ${lineJoin}
      where ${where}
      order by coalesce("order"."placed_at", "order"."created_at") desc, "order"."code"${lineOrder}
      limit ${EXPORT_ROW_CAP}`);
    return (r as unknown as { rows: ExportRow[] }).rows;
  });
}

/** Spreadsheet formula-injection guard for free-text string cells. */
const guardCell = (v: Cell): Cell => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function exportCellValues(cols: Col[], r: ExportRow, opts: { guard: boolean }): Cell[] {
  return cols.map((c) => { const v = c.get(r); return opts.guard ? guardCell(v) : v; });
}
