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

/**
 * Parse pasted/uploaded CSV text into rows. Accepts a header line, comma, tab
 * or semicolon separators and quoted cells; columns are order, tracking,
 * carrier (optional). Header names are matched loosely when present.
 */
export function parseTrackingCsv(text: string): TrackingRowInput[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const split = (line: string): string[] => {
    const delim = line.includes('\t') ? '\t' : line.includes(';') && !line.includes(',') ? ';' : ',';
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  let idx = { code: 0, tracking: 1, carrier: 2 };
  const first = split(lines[0]!).map((h) => h.toLowerCase());
  const looksLikeHeader = first.some((h) => /^(order|code|order[_ ]?(code|number|id)|tracking|tracking[_ ]?(number|code)|carrier)$/.test(h));
  let body = lines;
  if (looksLikeHeader) {
    body = lines.slice(1);
    const find = (re: RegExp, dflt: number) => { const i = first.findIndex((h) => re.test(h)); return i >= 0 ? i : dflt; };
    idx = { code: find(/^(order|code|order[_ ]?(code|number|id))$/, 0), tracking: find(/^tracking/, 1), carrier: find(/^carrier/, 2) };
  }
  return body.map((l) => {
    const c = split(l);
    return { code: c[idx.code] ?? '', tracking: c[idx.tracking] ?? '', carrier: c[idx.carrier] || undefined };
  });
}
