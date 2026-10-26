/**
 * Tracking import — row normalisation, classification and "did you mean"
 * suggestions. Pure (no DB): admin-order-ops.ts feeds it facts loaded from the
 * order and uses the verdict for both the dry-run preview and the commit, so
 * the two can never disagree about which rows are importable.
 */
import { inferCarrier } from '../routes/admin-order-utils.js';

export type TrackingRowInput = { code: string; tracking: string; carrier?: string | null };

export type TrackingStatus =
  | 'ready'            // ships the remaining items with this tracking number
  | 'update_tracking'  // order already fully shipped; replaces the tracking number
  | 'unknown_order'
  | 'missing_tracking'
  | 'missing_code'
  | 'already_shipped'  // same tracking number already on this order
  | 'nothing_to_ship'
  | 'not_shippable'
  | 'duplicate_in_file';

export const IMPORTABLE: ReadonlySet<TrackingStatus> = new Set(['ready', 'update_tracking']);

export type OrderFacts = {
  state: string;
  deleted: boolean;
  lines: Array<{ sku: string; name: string; quantity: number; fulfilledQty: number; cancelledQty: number }>;
  fulfillments: Array<{ state: string; trackingCode: string | null }>;
};

export type TrackingVerdict = {
  status: TrackingStatus;
  message: string;
  /** Items that will ship with this row (remaining quantities). */
  items: Array<{ sku: string; name: string; quantity: number }>;
};

/** Order codes are compared upper-case; a leading '#' (copied from an admin UI) is dropped. */
export const normalizeOrderCode = (v: string) => v.trim().replace(/^#/, '').trim().toUpperCase();
export const normalizeTracking = (v: string) => v.replace(/\s+/g, '');

export function resolveCarrier(row: TrackingRowInput): { carrier: string | null; source: 'given' | 'detected' | 'unknown' } {
  const given = row.carrier?.trim();
  if (given) return { carrier: given, source: 'given' };
  const detected = inferCarrier(row.tracking);
  return detected ? { carrier: detected, source: 'detected' } : { carrier: null, source: 'unknown' };
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Closest known code within edit distance 2 (1 for short codes); ties resolve to the first candidate. */
export function suggestOrderCode(code: string, candidates: readonly string[]): string | null {
  const target = normalizeOrderCode(code);
  if (!target) return null;
  const limit = target.length <= 5 ? 1 : 2;
  let best: { code: string; d: number } | null = null;
  for (const c of candidates) {
    const d = levenshtein(target, c.toUpperCase());
    if (d > 0 && d <= limit && (!best || d < best.d)) best = { code: c, d };
  }
  return best?.code ?? null;
}

export function remainingItems(lines: OrderFacts['lines']): TrackingVerdict['items'] {
  return lines
    .map((l) => ({ sku: l.sku, name: l.name, quantity: l.quantity - l.fulfilledQty - l.cancelledQty }))
    .filter((l) => l.quantity > 0);
}

/** Classify one row against the order's current facts (order already found). */
export function classifyTrackingRow(tracking: string, facts: OrderFacts): TrackingVerdict {
  const items = remainingItems(facts.lines);
  if (facts.deleted) return { status: 'not_shippable', message: 'order is in the trash', items: [] };
  if (facts.state !== 'Paid' && facts.state !== 'PartiallyRefunded') {
    return { status: 'not_shippable', message: facts.state === 'PendingPayment' ? 'not paid yet' : `not shippable (${facts.state})`, items: [] };
  }
  const active = facts.fulfillments.filter((f) => f.state !== 'Cancelled');
  if (active.some((f) => (f.trackingCode ?? '').toUpperCase() === tracking.toUpperCase() && f.state !== 'Pending')) {
    return { status: 'already_shipped', message: 'this tracking number is already on the order', items: [] };
  }
  if (items.length > 0) return { status: 'ready', message: 'ships remaining items', items };
  const last = active[0];
  if (last && last.state === 'Pending') return { status: 'ready', message: 'marks the pending shipment as shipped', items: [] };
  if (last && last.state === 'Shipped') return { status: 'update_tracking', message: `replaces tracking ${last.trackingCode ?? '(none)'}`, items: [] };
  if (last && last.state === 'Delivered') return { status: 'nothing_to_ship', message: 'already delivered', items: [] };
  return { status: 'nothing_to_ship', message: 'nothing left to ship', items: [] };
}

/** Pre-DB row checks (empty cells). Returns null when the row is worth looking up. */
export function precheckRow(code: string, tracking: string): TrackingVerdict | null {
  if (!code) return { status: 'missing_code', message: 'order code is empty', items: [] };
  if (!tracking) return { status: 'missing_tracking', message: 'tracking number is empty', items: [] };
  return null;
}

/** How a tracking file was read (shown in the preview so the operator can see which columns were used). */
export interface TrackingParseInfo {
  /** The first line was a title (Avid/VeraCore "Product Shipment Datasheet - …"), not column names, and was skipped. */
  titleSkipped: boolean;
  /** Column names of the header row used, or null when the file has none (then: order, tracking, carrier by position). */
  header: string[] | null;
  columns: { order: string; tracking: string; carrier: string | null };
  /** Data rows left out: no order or no tracking number, Amazon order ids, and repeats of the same order + tracking. */
  skipped: { blank: number; amazon: number; duplicate: number };
  /** Each left-out row (first 200): its line in the file, what it held and why it was left out. */
  skippedRows: Array<{ line: number; code: string; tracking: string; reason: 'blank' | 'amazon' | 'duplicate' }>;
}

// The previous admin importer's column names (the Damned order-tools tracking import), first match
// wins, plus this importer's own simple headers. Matched case-insensitively.
const ORDER_HEADERS = ['order code', 'orderid', 'order_code', 'order', 'code', 'order number', 'order_number', 'order id', 'order_id'];
const TRACKING_HEADERS = ['shpack_trackingid', 'tracking code', 'tracking', 'tracking_code', 'tracking number', 'tracking_number'];
const CARRIER_HEADERS = ['carrier', 'provider'];
const KNOWN_HEADERS = new Set([...ORDER_HEADERS, ...TRACKING_HEADERS, ...CARRIER_HEADERS]);
const AMAZON_ORDER = /^\d{3}-\d{7}-\d{7}$/;

/** RFC 4180 records: quoted fields may hold the separator, doubled quotes and line breaks. */
function csvRecords(text: string): string[][] {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join('\n');
  const delim = sample.includes('\t') ? '\t' : sample.includes(';') && !sample.includes(',') ? ';' : ',';
  const out: string[][] = [];
  let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur.trim()); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur.trim()); cur = '';
      if (row.some((c) => c !== '')) out.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur.trim());
  if (row.some((c) => c !== '')) out.push(row);
  return out;
}

const isHeader = (rec: string[] | undefined) => !!rec && rec.some((c) => KNOWN_HEADERS.has(c.toLowerCase()));
const pick = (header: string[], names: string[]) => {
  const lower = header.map((h) => h.toLowerCase());
  for (const n of names) { const i = lower.indexOf(n); if (i >= 0) return i; }
  return -1;
};

/**
 * Parse an uploaded/pasted tracking file. Accepts the Avid/VeraCore "Product Shipment Datasheet" export unchanged,
 * with the previous admin importer's rules: a first line that names none of the known columns is a title and is skipped;
 * order = order code | OrderId | order_code; tracking = shpack_trackingid | tracking code | tracking | tracking_code;
 * carrier = carrier | provider (else detected from the number). Rows without an order or a tracking number, Amazon
 * order ids (111-1234567-1234567) and repeats of the same order + tracking are left out. A file with no header row is
 * read by position: order, tracking, carrier. Comma, tab or semicolon separated; quoted cells may span lines.
 */
export function parseTrackingFile(text: string): { rows: TrackingRowInput[]; info: TrackingParseInfo } {
  const records = csvRecords(text.replace(/^\uFEFF/, ''));
  let titleSkipped = false;
  let header: string[] | null = null;
  let body = records;
  if (isHeader(records[0])) { header = records[0]!; body = records.slice(1); }
  else if (isHeader(records[1])) { titleSkipped = true; header = records[1]!; body = records.slice(2); }
  let idx = { code: 0, tracking: 1, carrier: 2 };
  if (header) {
    const c = pick(header, CARRIER_HEADERS);
    idx = { code: pick(header, ORDER_HEADERS), tracking: pick(header, TRACKING_HEADERS), carrier: c };
  }
  const info: TrackingParseInfo = {
    titleSkipped, header,
    columns: header
      ? { order: idx.code >= 0 ? header[idx.code]! : '(not found)', tracking: idx.tracking >= 0 ? header[idx.tracking]! : '(not found)', carrier: idx.carrier >= 0 ? header[idx.carrier]! : null }
      : { order: 'column 1', tracking: 'column 2', carrier: 'column 3' },
    skipped: { blank: 0, amazon: 0, duplicate: 0 },
    skippedRows: [],
  };
  const skip = (line: number, code: string, tracking: string, reason: 'blank' | 'amazon' | 'duplicate') => {
    info.skipped[reason]++;
    if (info.skippedRows.length < 200) info.skippedRows.push({ line, code, tracking, reason });
  };
  const firstDataLine = (header ? 1 : 0) + (titleSkipped ? 1 : 0) + 1;
  const rows: TrackingRowInput[] = [];
  const seen = new Set<string>();
  for (let n = 0; n < body.length; n++) {
    const rec = body[n]!;
    // Record number in the file (blank lines are not counted; a quoted multi-line cell counts once).
    const line = firstDataLine + n;
    const code = idx.code >= 0 ? (rec[idx.code] ?? '').trim() : '';
    const tracking = idx.tracking >= 0 ? (rec[idx.tracking] ?? '').trim() : '';
    if (!code || !tracking) { skip(line, code, tracking, 'blank'); continue; }
    if (AMAZON_ORDER.test(code)) { skip(line, code, tracking, 'amazon'); continue; }
    const key = `${code.toUpperCase()}:${tracking}`;
    if (seen.has(key)) { skip(line, code, tracking, 'duplicate'); continue; }
    seen.add(key);
    const carrier = idx.carrier >= 0 ? (rec[idx.carrier] ?? '').trim() : '';
    rows.push({ code, tracking, carrier: carrier || undefined });
  }
  return { rows, info };
}

/** The rows of a tracking file (see parseTrackingFile). */
export function parseTrackingCsv(text: string): TrackingRowInput[] {
  return parseTrackingFile(text).rows;
}
