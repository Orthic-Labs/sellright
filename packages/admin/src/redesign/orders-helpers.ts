/** #406 orders list: tabs, derived pills, saved views and column prefs. Pure helpers, no React. */
import type { OrderRow } from '../api';
import { paymentDef } from '../lib/order-status';

export type PillTone = 'ok' | 'warn' | 'bad' | 'info' | 'neu';
export interface Pill { tone: PillTone; label: string }

/** `tab` values the API accepts, plus the client-only `all` and `archived` (trash). */
export const TABS = [
  { key: 'tofulfil', label: 'To fulfil' },
  { key: 'pre', label: 'Pre-orders' },
  { key: 'partial', label: 'Partial' },
  { key: 'unpaid', label: 'Unpaid' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'refunded', label: 'Refunded' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
  { key: 'archived', label: 'Archived' },
] as const;
export type TabKey = (typeof TABS)[number]['key'];
export const DEFAULT_TAB: TabKey = 'tofulfil';
export const isTabKey = (v: string | null): v is TabKey => TABS.some((t) => t.key === v);
/** Tabs without a server count (All is unbadged in the design; the trash has no count endpoint). */
export const UNCOUNTED: ReadonlySet<string> = new Set(['all', 'archived']);

export function fulfilmentPill(o: Pick<OrderRow, 'state' | 'status' | 'openQty' | 'openPreOrderQty' | 'shippedQty'>): Pill {
  if (o.status === 'cancelled' || o.state === 'Cancelled') return { tone: 'neu', label: 'Cancelled' };
  const open = o.openQty ?? 0, pre = o.openPreOrderQty ?? 0, shipped = o.shippedQty ?? 0;
  if (open === 0 && shipped === 0) return { tone: 'neu', label: 'Nothing to ship' };
  if (open > 0 && open === pre) return { tone: 'info', label: 'Pre-order' };
  if (shipped > 0 && open > 0) return { tone: 'warn', label: 'Partially fulfilled' };
  if (open > 0) return { tone: 'warn', label: 'Unfulfilled' };
  return { tone: 'ok', label: 'Fulfilled' };
}

/** #406: the Items cell. Units removed before shipping are counted as removed, so a fully removed order never reads "0 items". */
export function itemsCopy(o: Pick<OrderRow, 'openQty' | 'shippedQty' | 'removedQty'>): string {
  if (o.openQty == null) return '—';
  const n = o.openQty + (o.shippedQty ?? 0), removed = o.removedQty ?? 0;
  const items = `${n} item${n === 1 ? '' : 's'}`;
  if (!removed) return items;
  return n ? `${items} · ${removed} removed` : `${removed} removed`;
}

const TONE: Record<string, PillTone> = { positive: 'ok', attention: 'warn', critical: 'bad', info: 'info', neutral: 'neu' };
export function paymentPill(status?: string | null): Pill {
  const d = paymentDef(status);
  return { tone: TONE[d.tone] ?? 'neu', label: d.label };
}

/** Units that can ship now (open, not waiting on pre-order stock). */
export const shippableQty = (o: Pick<OrderRow, 'openQty' | 'openPreOrderQty'>): number => (o.openQty ?? 0) - (o.openPreOrderQty ?? 0);

// ---- saved views (localStorage; every access guarded) ----
const VIEWS_KEY = 'sr_orders_views_v3';
export interface SavedView { id: string; name: string; tab: TabKey; paymentStatus: string; shippingMethod: string; from: string; to: string }

export function loadViews(): SavedView[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is SavedView => !!v && typeof v.id === 'string' && typeof v.name === 'string' && isTabKey(v.tab ?? null))
      .map((v) => ({ ...v, paymentStatus: v.paymentStatus ?? '', shippingMethod: v.shippingMethod ?? '', from: v.from ?? '', to: v.to ?? '' }));
  } catch { return []; }
}
export function storeViews(views: SavedView[]): void {
  try { localStorage.setItem(VIEWS_KEY, JSON.stringify(views)); } catch { /* not persisted */ }
}

/** Returns an error message, or null when the name is usable. */
export function validateViewName(name: string, views: SavedView[]): string | null {
  const n = name.trim();
  if (!n) return 'Give the view a name.';
  if (n.length > 40) return 'Use 40 characters or fewer.';
  const lower = n.toLowerCase();
  if (TABS.some((t) => t.label.toLowerCase() === lower)) return 'That name is already used by a built-in tab.';
  if (views.some((v) => v.name.trim().toLowerCase() === lower)) return 'You already have a view with that name.';
  return null;
}

// ---- column picker ----
const COLS_KEY = 'sr_orders_cols_v1';
export type ColKey = 'placed' | 'items' | 'payment' | 'shipping';
export type Cols = Record<ColKey, boolean>;
export const COL_LABELS: Record<ColKey, string> = { placed: 'Placed', items: 'Items', payment: 'Payment', shipping: 'Shipping' };
export const DEFAULT_COLS: Cols = { placed: true, items: true, payment: true, shipping: true };

export function loadCols(): Cols {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLS_KEY) ?? '{}');
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      placed: r.placed !== false, items: r.items !== false, payment: r.payment !== false, shipping: r.shipping !== false,
    };
  } catch { return { ...DEFAULT_COLS }; }
}
export function storeCols(c: Cols): void {
  try { localStorage.setItem(COLS_KEY, JSON.stringify(c)); } catch { /* not persisted */ }
}
