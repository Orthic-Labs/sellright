/**
 * Order Export page (#381): the previous admin's statuses and columns (Damned order-tools OrderExportPage +
 * order-export.service), plus what Adrian asked for on top: rows (per line item / per order), format, column choice and
 * order, remembered per admin on the server (preference "order-export.last") with named presets ("order-export.presets").
 */
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
export const DEFAULT_STATUSES = ['PaymentAuthorized', 'Processing', 'Pre-ordered', 'PartiallyShipped', 'Modifying', 'ArrangingAdditionalPayment'];

/** The previous export's columns, in its order (headers as in the file). */
export const EXPORT_COLUMNS = [
  { key: 'orderCode', label: 'Order Code' }, { key: 'orderStatus', label: 'Status' }, { key: 'orderDate', label: 'Order Date' },
  { key: 'email', label: 'Email' }, { key: 'customerName', label: 'Customer Name' }, { key: 'name', label: 'Ship Name' },
  { key: 'company', label: 'Company' }, { key: 'street1', label: 'Street 1' }, { key: 'street2', label: 'Street 2' },
  { key: 'city', label: 'City' }, { key: 'state', label: 'State' }, { key: 'postCode', label: 'Post Code' },
  { key: 'country', label: 'Country' }, { key: 'phone', label: 'Phone' }, { key: 'trackingNumber', label: 'Tracking Number' },
  { key: 'sku', label: 'SKU' }, { key: 'productDescription', label: 'Product' }, { key: 'quantity', label: 'Qty' },
  { key: 'unitPriceUsd', label: 'Unit Price (USD)' }, { key: 'lineTotalUsd', label: 'Line Total (USD)' },
  { key: 'shippingCostUsd', label: 'Shipping (USD)' }, { key: 'orderSubtotalUsd', label: 'Subtotal (USD)' }, { key: 'orderTotalUsd', label: 'Order Total (USD)' },
] as const;
export const LINE_ITEM_KEYS = new Set(['sku', 'productDescription', 'quantity', 'unitPriceUsd', 'lineTotalUsd']);

export interface ExportSettings {
  statuses: string[];
  fromDate: string;
  toDate: string;
  rows: 'line' | 'order';
  format: 'xlsx' | 'csv';
  /** Every column, in the chosen order, with whether it is exported. */
  columns: { key: string; on: boolean }[];
}
export interface ExportPreset { name: string; settings: ExportSettings }

export const DEFAULT_SETTINGS: ExportSettings = {
  statuses: [...DEFAULT_STATUSES], fromDate: '', toDate: '', rows: 'line', format: 'xlsx',
  columns: EXPORT_COLUMNS.map((c) => ({ key: c.key, on: true })),
};

const STATUS_VALUES = new Set<string>(EXPORT_STATUSES.map((s) => s.value));
const COLUMN_KEYS: string[] = EXPORT_COLUMNS.map((c) => c.key);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A saved value made safe: unknown statuses/columns dropped, missing columns appended (on), defaults for the rest. */
export function normalizeSettings(raw: unknown): ExportSettings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<ExportSettings>;
  const seen = new Set<string>();
  const cols = (Array.isArray(v.columns) ? v.columns : [])
    .filter((c): c is { key: string; on: boolean } => !!c && typeof c.key === 'string' && COLUMN_KEYS.includes(c.key) && !seen.has(c.key) && !!seen.add(c.key))
    .map((c) => ({ key: c.key, on: c.on !== false }));
  for (const key of COLUMN_KEYS) if (!seen.has(key)) cols.push({ key, on: true });
  return {
    statuses: Array.isArray(v.statuses) ? v.statuses.filter((x) => STATUS_VALUES.has(x)) : [...DEFAULT_STATUSES],
    fromDate: typeof v.fromDate === 'string' && DAY.test(v.fromDate) ? v.fromDate : '',
    toDate: typeof v.toDate === 'string' && DAY.test(v.toDate) ? v.toDate : '',
    rows: v.rows === 'order' ? 'order' : 'line',
    format: v.format === 'csv' ? 'csv' : 'xlsx',
    columns: cols,
  };
}

export function normalizePresets(raw: unknown): ExportPreset[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((p): p is ExportPreset => !!p && typeof p.name === 'string' && !!p.name.trim())
    .map((p) => ({ name: p.name.trim().slice(0, 60), settings: normalizeSettings(p.settings) }));
}

/** Move a column up (-1) or down (+1). */
export function moveColumn(cols: ExportSettings['columns'], index: number, dir: -1 | 1): ExportSettings['columns'] {
  const j = index + dir;
  if (j < 0 || j >= cols.length) return cols;
  const next = [...cols];
  [next[index], next[j]] = [next[j]!, next[index]!];
  return next;
}

/** Query string for the count (filters only) or the download (filters + rows, format, columns in order). */
export function exportQuery(s: ExportSettings, forDownload: boolean): string {
  const p = new URLSearchParams({ statuses: s.statuses.join(',') });
  if (s.fromDate) p.set('fromDate', s.fromDate);
  if (s.toDate) p.set('toDate', s.toDate);
  if (forDownload) {
    p.set('rows', s.rows);
    p.set('format', s.format);
    p.set('columns', s.columns.filter((c) => c.on).map((c) => c.key).join(','));
  }
  return p.toString();
}
