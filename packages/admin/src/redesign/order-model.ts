/**
 * #406 order page + dialogs: pure quantity and money rules, shared by OrderDetail, Fulfil, Refund and Cancel.
 * The server enforces every one of these; the UI mirrors them so nothing is offered that would be refused.
 */
import { refundAvailableUnits, refundCashForQuantity } from '../api';
import type { OrderDetailX } from '../components/order-edit/types';

/** Line as the detail API returns it. `isPreOrder` / `shipDateLabel` are read when the API sends them (it does not yet). */
export type OrderLine = OrderDetailX['lines'][number] & { isPreOrder?: boolean; shipDateLabel?: string | null };
export type OrderView = Omit<OrderDetailX, 'lines'> & { lines: OrderLine[]; isPreOrder?: boolean };

export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
export const isInt = (v: string, min = 0): boolean => /^\d{1,9}$/.test(v.trim()) && Number(v) >= min;

/** Units still to ship: ordered less shipped less removed. */
export const openQty = (l: OrderLine): number => Math.max(0, l.quantity - l.fulfilledQty - l.cancelledQty);
export const isPre = (l: OrderLine): boolean => l.isPreOrder === true;
/** Units that can still be refunded (server availability when sent, else quantity less refunded). */
export const refundable = (l: OrderLine): number => refundAvailableUnits(l) ?? 0;

export const canShipState = (o: Pick<OrderView, 'state'>): boolean => o.state === 'Paid' || o.state === 'PartiallyRefunded';
export const canShip = (o: OrderView): boolean => canShipState(o) && o.lines.some((l) => !isPre(l) && openQty(l) > 0);

const liveRefunds = (o: OrderView) => o.refunds.filter((r) => r.state !== 'Failed');

/** Shipped units already refunded (refunding an unshipped unit raises both refundedQty and cancelledQty). */
export const shippedRefunded = (l: OrderLine): number => Math.min(l.fulfilledQty, Math.max(0, l.refundedQty - l.cancelledQty));
/** Shipped units already put back in stock, from the refund history. */
export function restockedUnits(o: OrderView, l: OrderLine): number {
  const flagged = liveRefunds(o).reduce((n, r) => n + r.lines.filter((x) => x.orderLineId === l.id && x.restock).reduce((m, x) => m + x.quantity, 0), 0);
  return Math.min(flagged, shippedRefunded(l));
}
/** Shipped units not yet restocked. */
export const rsLeft = (o: OrderView, l: OrderLine): number => Math.max(0, l.fulfilledQty - restockedUnits(o, l));
/** Of `q` units refunded now, how many are shipped units (the rest are unshipped and just released). */
export const shippedPart = (l: OrderLine, q: number): number =>
  Math.min(Math.max(0, q - openQty(l)), Math.max(0, l.fulfilledQty - shippedRefunded(l)));
/** Units of this refund that can go back in stock. */
export const restockable = (o: OrderView, l: OrderLine, q: number): number => Math.min(shippedPart(l, q), rsLeft(o, l));

/** Shipping the customer paid that has not been refunded yet. */

export const refundedTotal = (o: OrderView): number => o.refunds.filter((r) => r.state === 'Settled' || r.state === 'Pending').reduce((n, r) => n + r.amount, 0);
export const paidTotal = (o: OrderView): number => o.payments.filter((p) => p.state === 'Settled' || p.state === 'captured').reduce((n, p) => n + p.amount, 0);

/** Shipping still refundable. Orders imported without native totals (grand total 0, shipping 0, money on the
 *  payment) have no shipping figure to cap against, so the payment's remaining balance is the limit, as on the server. */
export const shippingLeft = (o: OrderView): number =>
  o.grandTotal <= 0 && paidTotal(o) > 0
    ? Math.max(0, paidTotal(o) - refundedTotal(o))
    : Math.max(0, o.shippingTotal - liveRefunds(o).reduce((n, r) => n + (r.shippingAmount ?? 0), 0));

/** Parse "8.00" into cents; null when it is not a plain amount of 0 or more. */
export function parseMoney(raw: string): number | null {
  const v = raw.trim() || '0';
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}

export type Tone = 'ok' | 'warn' | 'info' | 'neu' | 'bad';

/** Fulfilment pill, derived from quantities only (never from a stored status). */
export function fulfilmentPill(o: OrderView): [Tone, string] {
  if (o.state === 'Cancelled') return ['neu', 'Cancelled'];
  if (o.state === 'PendingPayment') return ['neu', 'Awaiting payment'];
  const open = o.lines.filter((l) => openQty(l) > 0);
  const shipped = o.lines.some((l) => l.fulfilledQty > 0);
  if (!open.length) return shipped ? ['ok', 'Fulfilled'] : ['neu', 'Nothing to ship'];
  if (open.every(isPre)) return ['info', 'Pre-order'];
  return shipped ? ['warn', 'Partially fulfilled'] : ['warn', 'Unfulfilled'];
}

export function paymentPill(o: OrderView): [Tone, string] {
  if (o.state === 'Cancelled') return ['neu', 'Cancelled'];
  if (o.state === 'PendingPayment') return ['warn', 'Awaiting payment'];
  if (o.state === 'Refunded') return ['neu', 'Refunded'];
  if (o.state === 'PartiallyRefunded') return ['warn', 'Partially refunded'];
  return ['ok', 'Paid'];
}

/** "Nothing left to ship" copy, worded from what actually happened to the units. */
export function doneCopy(o: OrderView): string {
  const shipped = o.lines.reduce((n, l) => n + l.fulfilledQty, 0);
  const removed = o.lines.reduce((n, l) => n + l.cancelledQty, 0);
  if (o.state === 'Cancelled') {
    return shipped
      ? `Cancelled. ${plural(shipped, 'item')} shipped before the cancellation${removed ? `; ${plural(removed, 'item')} did not ship` : ''}.`
      : 'Cancelled before anything shipped.';
  }
  if (shipped && removed) return `${plural(shipped, 'item')} shipped; ${plural(removed, 'item')} removed before shipping.`;
  if (shipped) return `${plural(shipped, 'item')} shipped. Nothing left to ship.`;
  if (removed) return 'Nothing to ship: every item was removed before shipping.';
  return 'Nothing to ship.';
}

/** Tracking number check (mockup trackErr). Empty is fine: tracking is optional. */
export function trackErr(raw: string): string {
  const t = raw.replace(/[\s-]/g, '');
  if (!t) return '';
  if (!/^[A-Za-z0-9]+$/.test(t)) return 'Use letters and numbers only. Spaces and dashes are fine.';
  if (t.length < 8) return 'Too short for a tracking number. Check it, or leave it empty to ship without tracking.';
  return '';
}

/** Carrier guess from a tracking number (patterns the mockup uses). Null when unsure. */
export function detectCarrier(raw: string): 'USPS' | 'UPS' | null {
  const t = raw.replace(/\s/g, '');
  if (/^9[2-5]/.test(t)) return 'USPS';
  if (/^1Z/i.test(t)) return 'UPS';
  return null;
}

export const CARRIERS = ['USPS', 'UPS', 'FedEx', 'DHL', 'Other'] as const;

export interface RefundLineInput { orderLineId: string; quantity: number; restock: boolean }
export interface RefundPlan {
  lines: RefundLineInput[];
  /** Items cash; null when the server did not send a proven price for a selected unit. */
  items: number | null;
  restockUnits: number;
  releasedUnits: number;
}

/** Quantities typed per line (+ restock ticks) to the exact payload lines and totals. */
export function planRefund(o: OrderView, qty: Record<string, number>, restock: Record<string, boolean>): RefundPlan {
  const lines: RefundLineInput[] = [];
  let items: number | null = 0;
  let restockUnits = 0;
  let releasedUnits = 0;
  for (const l of o.lines) {
    const q = qty[l.id] ?? 0;
    if (q <= 0) continue;
    const rs = restock[l.id] ? restockable(o, l, q) : 0;
    lines.push({ orderLineId: l.id, quantity: q, restock: rs > 0 });
    restockUnits += rs;
    releasedUnits += Math.min(q, openQty(l));
    const cash = refundCashForQuantity(l, q);
    items = cash === null || items === null ? null : items + cash;
  }
  return { lines, items, restockUnits, releasedUnits };
}
