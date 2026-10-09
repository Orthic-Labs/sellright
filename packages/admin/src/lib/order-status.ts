/**
 * Owner-facing order statuses: exactly three columns — Payment, Fulfillment,
 * Order — never the internal state names (PendingPayment, PartiallyRefunded…).
 * `authorized` and `voided` exist in the API for gateways that authorize
 * first; Damned's NMI/Sezzle capture immediately, so the UI hides them.
 */
import type { BadgeTone } from '../components/ui';

type Def = { label: string; tone: BadgeTone };

const PAYMENT: Record<string, Def> = {
  pending: { label: 'Pending', tone: 'attention' },
  paid: { label: 'Paid', tone: 'positive' },
  balance_due: { label: 'Balance due', tone: 'attention' },
  partially_refunded: { label: 'Partially refunded', tone: 'critical' },
  refunded: { label: 'Refunded', tone: 'critical' },
  failed: { label: 'Failed', tone: 'critical' },
  // Not offered as filters, but a row may still carry them (other gateways).
  authorized: { label: 'Authorized', tone: 'info' },
  voided: { label: 'Voided', tone: 'neutral' },
};
const FULFILLMENT: Record<string, Def> = {
  unfulfilled: { label: 'Unfulfilled', tone: 'attention' },
  partially_fulfilled: { label: 'Partially fulfilled', tone: 'info' },
  fulfilled: { label: 'Fulfilled', tone: 'info' },
  partially_delivered: { label: 'Partially delivered', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'positive' },
};
const ORDER: Record<string, Def> = {
  open: { label: 'Open', tone: 'neutral' },
  completed: { label: 'Open', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  archived: { label: 'Archived', tone: 'neutral' },
};

const FALLBACK: Def = { label: '—', tone: 'neutral' };
export const paymentDef = (v?: string | null): Def => (v ? PAYMENT[v] ?? { label: v, tone: 'neutral' } : FALLBACK);
export const fulfillmentDef = (v?: string | null): Def => (v ? FULFILLMENT[v] ?? { label: v, tone: 'neutral' } : FALLBACK);
export const orderDef = (v?: string | null): Def => (v ? ORDER[v] ?? { label: v, tone: 'neutral' } : FALLBACK);

export type Option = { value: string; label: string };
export const PAYMENT_OPTIONS: Option[] = ['pending', 'paid', 'balance_due', 'partially_refunded', 'refunded', 'failed'].map((v) => ({ value: v, label: PAYMENT[v]!.label }));
export const FULFILLMENT_OPTIONS: Option[] = ['unfulfilled', 'partially_fulfilled', 'fulfilled', 'delivered'].map((v) => ({ value: v, label: FULFILLMENT[v]!.label }));
/** `active` is the API's open+completed union — shown to the owner as "Open". */
export const ORDER_OPTIONS: Option[] = [
  { value: 'active', label: 'Open' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'archived', label: 'Archived' },
];

/** Order-list filter set; URL params are the source of truth. */
export interface OrderFilters {
  q: string; paymentStatus: string; fulfillmentStatus: string; status: string; from: string; to: string; preOrder: boolean;
}
export const EMPTY_FILTERS: OrderFilters = { q: '', paymentStatus: '', fulfillmentStatus: '', status: '', from: '', to: '', preOrder: false };

export function filtersFromParams(p: URLSearchParams): OrderFilters {
  const pick = (k: string, allowed: Option[]) => { const v = p.get(k) ?? ''; return allowed.some((o) => o.value === v) ? v : ''; };
  const day = (k: string) => { const v = p.get(k) ?? ''; return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; };
  return {
    q: p.get('q') ?? '',
    paymentStatus: pick('paymentStatus', PAYMENT_OPTIONS),
    fulfillmentStatus: pick('fulfillmentStatus', FULFILLMENT_OPTIONS),
    status: pick('status', ORDER_OPTIONS),
    from: day('from'), to: day('to'),
    preOrder: p.get('preOrder') === '1',
  };
}

export function filtersToParams(f: OrderFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.paymentStatus) p.set('paymentStatus', f.paymentStatus);
  if (f.fulfillmentStatus) p.set('fulfillmentStatus', f.fulfillmentStatus);
  if (f.status) p.set('status', f.status);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.preOrder) p.set('preOrder', '1');
  return p;
}

/** API list query for a filter set (archived = trash view). */
export function filtersToApiQuery(f: OrderFilters, page: number, pageSize = 25): URLSearchParams {
  const p = filtersToParams(f);
  if (f.status === 'archived') { p.delete('status'); p.set('trashed', '1'); }
  p.set('page', String(page)); p.set('pageSize', String(pageSize));
  return p;
}

/** Export query for the same filter set (archived = trashed). */
export function filtersToExportQuery(f: OrderFilters): URLSearchParams {
  const p = filtersToParams(f);
  p.delete('status');
  if (f.status === 'archived') p.set('trashed', '1');
  else if (f.status) p.set('status', f.status); // cancelled | active (open+completed, same as the list)
  return p;
}

export interface ViewDef { id: string; label: string; filters: Partial<OrderFilters>; title: string }
/** Built-in views. Exactly one row of these is rendered; user views are appended. */
export const BUILTIN_VIEWS: ViewDef[] = [
  { id: 'all', label: 'All', filters: {}, title: 'Every order, newest first' },
  { id: 'unfulfilled', label: 'Unfulfilled', filters: { paymentStatus: 'paid', fulfillmentStatus: 'unfulfilled', status: 'active' }, title: 'Paid orders with nothing shipped yet' },
  { id: 'partial', label: 'Partially fulfilled', filters: { paymentStatus: 'paid', fulfillmentStatus: 'partially_fulfilled', status: 'active' }, title: 'Paid orders with some items still to ship' },
  { id: 'unpaid', label: 'Unpaid', filters: { paymentStatus: 'pending', status: 'active' }, title: 'Orders waiting for payment' },
  { id: 'preorder', label: 'Pre-orders', filters: { preOrder: true }, title: 'Orders containing pre-order items' },
  { id: 'balance_due', label: 'Balance due', filters: { paymentStatus: 'balance_due', status: 'active' }, title: 'Edited orders where the customer still owes money' },
  { id: 'refunded', label: 'Refunded', filters: { paymentStatus: 'refunded' }, title: 'Fully refunded orders' },
  { id: 'cancelled', label: 'Cancelled', filters: { status: 'cancelled' }, title: 'Cancelled orders' },
  { id: 'archived', label: 'Archived', filters: { status: 'archived' }, title: 'Orders moved to the trash (restorable)' },
];

export const sameFilters = (a: OrderFilters, b: Partial<OrderFilters>): boolean => {
  const full = { ...EMPTY_FILTERS, ...b };
  return (Object.keys(EMPTY_FILTERS) as Array<keyof OrderFilters>).every((k) => (k === 'q' ? true : a[k] === full[k]));
};

export const customerLabel = (r: { firstName?: string | null; lastName?: string | null; email: string | null }): { name: string | null; email: string | null } => ({
  name: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
  email: r.email,
});
