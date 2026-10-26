/**
 * Order Export page (#381): a 1:1 port of the previous admin's order-tools export (Damned order-tools
 * services/order-export.service.ts + dashboard/OrderExportPage.tsx): one display status per order, picked by checkbox,
 * optional created-date range, XLSX with the same 23 columns in the same order, one row per order line (quantity > 0),
 * frozen bold header, $ formats. Guest orders use their own checkout contact (#374). Trashed and demo orders are left out.
 *
 * Status mapping (previous admin status → SellRight), first match wins per order:
 *   Cancelled → state Cancelled · Refunded → state Refunded · Modifying → an order edit still pending
 *   More Payment Due → paid but an edit left a balance due · Authorized → unpaid with an authorised payment
 *   Delivered / Partially Delivered / Shipped / Partially Shipped → fulfilment status of a paid order
 *   Pre-ordered / Processing → paid, nothing shipped, pre-order or not.
 *   Dropped (no SellRight meaning): Arrange Shipping, Adding Items (cart); unpaid checkouts are not exported.
 */
import ExcelJS from 'exceljs';
import { sql, type SQL } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { orderContactSql } from './contact.js';
import { balanceDueSql, fulfillmentStatusSql } from './status-sql.js';
import { importedFinancialReconciliationPath } from '../import/source-compatibility.js';

export const EXPORT_STATUSES = [
  { value: 'Processing', label: 'Processing' },
  { value: 'Pre-ordered', label: 'Pre-ordered' },
  { value: 'PaymentAuthorized', label: 'Authorized' },
  { value: 'PartiallyShipped', label: 'Partially Shipped' },
  { value: 'Shipped', label: 'Shipped' },
  { value: 'PartiallyDelivered', label: 'Partially Delivered' },
  { value: 'Delivered', label: 'Delivered' },
  { value: 'Modifying', label: 'Modifying' },
  { value: 'ArrangingAdditionalPayment', label: 'More Payment Due' },
  { value: 'Refunded', label: 'Refunded' },
  { value: 'Cancelled', label: 'Cancelled' },
] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number]['value'];
export const DEFAULT_EXPORT_STATUSES: ExportStatus[] = ['PaymentAuthorized', 'Processing', 'Pre-ordered', 'PartiallyShipped', 'Modifying', 'ArrangingAdditionalPayment'];
const VALUES = new Set<string>(EXPORT_STATUSES.map((s) => s.value));
const LABEL = new Map<string, string>(EXPORT_STATUSES.map((s) => [s.value, s.label]));

export interface OrderExportFilters { statuses: ExportStatus[]; fromDate?: string; toDate?: string }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Query-string filters: unknown statuses dropped; an absent list = the default (open orders), as before. */
export function parseOrderExportFilters(get: (k: string) => string | undefined): OrderExportFilters {
  const raw = get('statuses');
  const statuses = (raw === undefined ? DEFAULT_EXPORT_STATUSES : raw.split(',').map((s) => s.trim()).filter((s) => VALUES.has(s))) as ExportStatus[];
  const from = get('fromDate'); const to = get('toDate');
  return { statuses, ...(from && DAY.test(from) ? { fromDate: from } : {}), ...(to && DAY.test(to) ? { toDate: to } : {}) };
}

const pendingEdit = sql`exists (select 1 from order_edit e where e.order_id = "order".id
  and e.settlement->>'phase' in ('prepared', 'awaiting_refund', 'awaiting_tender', 'ready', 'failed'))`;
const notImported = sql`("order".metadata #> ARRAY[${importedFinancialReconciliationPath[0]}, ${importedFinancialReconciliationPath[1]}]::text[]) is null`;

/** The one display status of an order (null = not exportable: an unpaid checkout). */
export function exportStatusSql(): SQL<string | null> {
  return sql<string | null>`(case
    when "order".state = 'Cancelled' then 'Cancelled'
    when "order".state = 'Refunded' then 'Refunded'
    when ${pendingEdit} then 'Modifying'
    when "order".state in ('Paid', 'PartiallyRefunded') and ${notImported} and ${balanceDueSql()} > 0 then 'ArrangingAdditionalPayment'
    when "order".state = 'PendingPayment' and exists (select 1 from payment p where p.order_id = "order".id and p.state = 'Authorized') then 'PaymentAuthorized'
    when "order".state = 'PendingPayment' then null
    when ${fulfillmentStatusSql()} = 'delivered' then 'Delivered'
    when ${fulfillmentStatusSql()} = 'partially_delivered' then 'PartiallyDelivered'
    when ${fulfillmentStatusSql()} = 'fulfilled' then 'Shipped'
    when ${fulfillmentStatusSql()} = 'partially_fulfilled' then 'PartiallyShipped'
    when "order".is_pre_order then 'Pre-ordered'
    else 'Processing'
  end)`;
}

function whereSql(f: OrderExportFilters): SQL {
  const parts: SQL[] = [sql`"order".deleted_at is null`, sql`"order".is_demo = false`,
    sql`${exportStatusSql()} = any(${sql.param(f.statuses.length ? f.statuses : ['__none__'])}::text[])`];
  if (f.fromDate) parts.push(sql`"order".created_at >= ${f.fromDate}::date`);
  if (f.toDate) parts.push(sql`"order".created_at < (${f.toDate}::date + interval '1 day')`);
  return sql.join(parts, sql` and `);
}

export async function countExportOrders(storeId: string, f: OrderExportFilters): Promise<number> {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`select count(*)::int as n from "order" where ${whereSql(f)}`);
    return (r.rows[0] as { n: number }).n;
  });
}

export interface ExportLineRow {
  orderCode: string; orderStatus: string; orderDate: string; email: string; customerName: string;
  name: string; company: string; street1: string; street2: string; city: string; state: string; postCode: string; country: string; phone: string;
  trackingNumber: string; sku: string | null; productDescription: string | null; quantity: number;
  unitPriceUsd: number | null; lineTotalUsd: number | null; shippingCostUsd: number | null; orderSubtotalUsd: number | null; orderTotalUsd: number | null;
}

export async function fetchExportLines(storeId: string, f: OrderExportFilters): Promise<ExportLineRow[]> {
  const contact = orderContactSql('cust');
  const addr = (k: string, alt?: string) => alt
    ? sql`coalesce(nullif("order".shipping_address->>${k}, ''), "order".shipping_address->>${alt}, '')`
    : sql`coalesce("order".shipping_address->>${k}, '')`;
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`
      select "order".code as "orderCode", ${exportStatusSql()} as "orderStatus",
        to_char("order".created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as "orderDate",
        coalesce(${contact.email}, 'No Email') as email, coalesce(${contact.name}, 'Guest Customer') as "customerName",
        ${addr('fullName')} as name, ${addr('company')} as company, ${addr('line1', 'streetLine1')} as street1, ${addr('line2', 'streetLine2')} as street2,
        ${addr('city')} as city, ${addr('province')} as state, ${addr('postalCode')} as "postCode", ${addr('country', 'countryCode')} as country,
        ${addr('phone', 'phoneNumber')} as phone,
        coalesce((select string_agg(distinct nullif(f.tracking_code, ''), ', ') from fulfillment f where f.order_id = "order".id and f.state <> 'Cancelled'), '') as "trackingNumber",
        ol.variant_sku as sku,
        case when coalesce(ol.product_name, '') = '' then ol.variant_name
             when coalesce(ol.variant_name, '') = '' or ol.variant_name = ol.product_name then ol.product_name
             else ol.product_name || ' - ' || ol.variant_name end as "productDescription",
        ol.quantity as quantity,
        (ol.unit_price / 100.0)::float8 as "unitPriceUsd",
        (ol.quantity * ol.unit_price / 100.0)::float8 as "lineTotalUsd",
        case when row_number() over (partition by "order".id order by ol.variant_sku, ol.id) = 1 then ("order".shipping_total / 100.0)::float8 end as "shippingCostUsd",
        case when row_number() over (partition by "order".id order by ol.variant_sku, ol.id) = 1 then ("order".subtotal / 100.0)::float8 end as "orderSubtotalUsd",
        case when row_number() over (partition by "order".id order by ol.variant_sku, ol.id) = 1 then ("order".grand_total / 100.0)::float8 end as "orderTotalUsd"
      from "order"
      left join customer cust on cust.id = "order".customer_id
      join order_line ol on ol.order_id = "order".id and ol.quantity > 0
      where ${whereSql(f)}
      order by "order".created_at desc, "order".id, ol.variant_sku, ol.id`);
    return (r.rows as unknown as ExportLineRow[]).map((row) => ({ ...row, orderStatus: LABEL.get(row.orderStatus) ?? row.orderStatus }));
  });
}

/** The previous admin's column set, in its order and widths. */
export const EXPORT_PAGE_COLUMNS: Array<{ header: string; key: keyof ExportLineRow; width: number }> = [
  { header: 'Order Code', key: 'orderCode', width: 12 }, { header: 'Status', key: 'orderStatus', width: 16 },
  { header: 'Order Date', key: 'orderDate', width: 20 }, { header: 'Email', key: 'email', width: 28 },
  { header: 'Customer Name', key: 'customerName', width: 22 }, { header: 'Ship Name', key: 'name', width: 22 },
  { header: 'Company', key: 'company', width: 20 }, { header: 'Street 1', key: 'street1', width: 24 },
  { header: 'Street 2', key: 'street2', width: 16 }, { header: 'City', key: 'city', width: 16 },
  { header: 'State', key: 'state', width: 8 }, { header: 'Post Code', key: 'postCode', width: 10 },
  { header: 'Country', key: 'country', width: 8 }, { header: 'Phone', key: 'phone', width: 16 },
  { header: 'Tracking Number', key: 'trackingNumber', width: 26 }, { header: 'SKU', key: 'sku', width: 18 },
  { header: 'Product', key: 'productDescription', width: 36 }, { header: 'Qty', key: 'quantity', width: 6 },
  { header: 'Unit Price (USD)', key: 'unitPriceUsd', width: 14 }, { header: 'Line Total (USD)', key: 'lineTotalUsd', width: 14 },
  { header: 'Shipping (USD)', key: 'shippingCostUsd', width: 14 }, { header: 'Subtotal (USD)', key: 'orderSubtotalUsd', width: 14 },
  { header: 'Order Total (USD)', key: 'orderTotalUsd', width: 14 },
];
const CURRENCY = new Set<string>(['unitPriceUsd', 'lineTotalUsd', 'shippingCostUsd', 'orderSubtotalUsd', 'orderTotalUsd']);
/** Line-item columns. With one row per order they are never dropped: they become one combined Items column. */
export const LINE_ITEM_KEYS = new Set<string>(['sku', 'productDescription', 'quantity', 'unitPriceUsd', 'lineTotalUsd']);
export const ITEMS_COLUMN = { header: 'Items', key: 'items', width: 60 } as const;
const COLUMN_KEYS = new Set<string>(EXPORT_PAGE_COLUMNS.map((c) => c.key));

export type ExportRowMode = 'line' | 'order';
export type ExportFormat = 'xlsx' | 'csv';
export interface ExportShape { mode: ExportRowMode; columns: string[]; format: ExportFormat }

/** Query-string shape: unknown columns dropped, order kept, none = every column in the previous admin's order. */
export function parseExportShape(get: (k: string) => string | undefined): ExportShape {
  const cols = (get('columns') ?? '').split(',').map((c) => c.trim()).filter((c, i, a) => COLUMN_KEYS.has(c) && a.indexOf(c) === i);
  return {
    mode: get('rows') === 'order' ? 'order' : 'line',
    columns: cols.length ? cols : EXPORT_PAGE_COLUMNS.map((c) => c.key),
    format: get('format') === 'csv' ? 'csv' : 'xlsx',
  };
}

type Cell = string | number | null;
export interface ShapedExport { columns: Array<{ header: string; key: string; width: number }>; rows: Cell[][]; orders: number }

/** The table to write: chosen columns in the chosen order; one row per line, or per order with an Items column. */
export function shapeExport(lines: ExportLineRow[], shape: ExportShape): ShapedExport {
  const byKey = new Map(EXPORT_PAGE_COLUMNS.map((c) => [c.key as string, c]));
  const orders = new Set(lines.map((l) => l.orderCode)).size;
  if (shape.mode === 'line') {
    const columns = shape.columns.map((k) => byKey.get(k)!);
    return { columns, orders, rows: lines.map((l) => columns.map((c) => l[c.key] as Cell)) };
  }
  // One row per order: the first line-item column chosen becomes Items (line items are never left out).
  const keys: string[] = [];
  for (const k of shape.columns) {
    if (LINE_ITEM_KEYS.has(k)) { if (!keys.includes(ITEMS_COLUMN.key)) keys.push(ITEMS_COLUMN.key); } else keys.push(k);
  }
  const columns = keys.map((k) => (k === ITEMS_COLUMN.key ? { ...ITEMS_COLUMN } : byKey.get(k)!));
  const groups = new Map<string, ExportLineRow[]>();
  for (const l of lines) { const g = groups.get(l.orderCode); if (g) g.push(l); else groups.set(l.orderCode, [l]); }
  const rows = [...groups.values()].map((g) => {
    const first = g[0]!;
    return columns.map((c) => c.key === ITEMS_COLUMN.key
      ? g.map((l) => `${l.quantity}x ${l.productDescription ?? ''}${l.sku ? ` (${l.sku})` : ''}`.trim()).join('; ')
      : (first[c.key as keyof ExportLineRow] as Cell));
  });
  return { columns, orders, rows };
}

/** Text cells are guarded against spreadsheet formula injection; numbers stay numbers. */
const guard = (v: Cell): Cell => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export async function exportWorkbook(shaped: ShapedExport, creator: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = creator;
  const sheet = wb.addWorksheet('Orders', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = shaped.columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = sheet.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  head.alignment = { vertical: 'middle' };
  for (const r of shaped.rows) sheet.addRow(r.map((v, i) => (CURRENCY.has(shaped.columns[i]!.key) || shaped.columns[i]!.key === 'quantity' ? (v == null ? null : Number(v)) : guard(v ?? ''))));
  shaped.columns.forEach((c, i) => { if (CURRENCY.has(c.key)) sheet.getColumn(i + 1).numFmt = '"$"#,##0.00'; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function exportCsv(shaped: ShapedExport): string {
  const cell = (v: Cell, key: string) => {
    const s = v == null ? '' : CURRENCY.has(key) ? Number(v).toFixed(2) : String(guard(v));
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [shaped.columns.map((c) => cell(c.header, '')).join(','), ...shaped.rows.map((r) => r.map((v, i) => cell(v, shaped.columns[i]!.key)).join(','))].join('\r\n') + '\r\n';
}
