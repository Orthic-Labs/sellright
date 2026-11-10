/**
 * #446 backorder: the ONE place the availability maths lives. Every storefront-facing reader of stock
 * (catalog, manifest, cart, feeds, JSON-LD, restock, order edit) goes through these, so "sellable" can never drift
 * between surfaces.
 *
 *   sellable  = on_hand + incoming - allocated   (what can still be reserved; floored at 0 for display)
 *   shipsNow  = greatest(on_hand - allocated, 0) (what leaves the warehouse now)
 *   backorder = shipsNow = 0 and sellable > 0    (nothing ships now, incoming units are still on offer)
 *
 * Zero-cache stock rule: these are pure functions over values the CALLER read live; nothing here caches. A missing
 * stock row passes null/undefined and fails closed (0 sellable, even when a label exists).
 */
import { sql, type SQL } from 'drizzle-orm';

export interface StockQuantities {
  onHand?: number | null;
  incoming?: number | null;
  allocated?: number | null;
}

/** Raw sellable (may be negative when allocated exceeds on_hand + incoming after an admin lowers stock). */
export function sellableRaw(q: StockQuantities): number {
  return (q.onHand ?? 0) + (q.incoming ?? 0) - (q.allocated ?? 0);
}

/** Units that can still be reserved, floored at 0. */
export function sellableQuantity(q: StockQuantities): number {
  return Math.max(0, sellableRaw(q));
}

/** Units that ship now (warehouse stock not yet allocated). */
export function shipsNowQuantity(q: StockQuantities): number {
  return Math.max(0, (q.onHand ?? 0) - (q.allocated ?? 0));
}

/** True when nothing ships now but incoming units are still sellable. */
export function isBackorder(q: StockQuantities): boolean {
  return shipsNowQuantity(q) === 0 && sellableQuantity(q) > 0;
}

/** True when a line of `quantity` needs any incoming unit (decided under the stock row lock at reservation). */
export function lineNeedsBackorder(q: StockQuantities, quantity: number): boolean {
  return quantity > shipsNowQuantity(q);
}

/** The label to show; trimmed, null when blank. */
export function normalizeBackorderLabel(label: string | null | undefined): string | null {
  const t = (label ?? '').trim();
  return t ? t : null;
}

/**
 * Minimum `incoming` an admin may leave in place: the already-sold backorder quantity greatest(allocated - on_hand, 0).
 * Lowering incoming below it would leave sold units with no stock to arrive.
 */
export function minIncoming(q: { onHand: number; allocated: number }): number {
  return Math.max(0, q.allocated - q.onHand);
}

/** SQL fragments over a `stock` alias (default `stk`), for raw queries. Missing row => null/0 per caller's coalesce. */
export function sellableSql(alias = 'stk'): string {
  return `(coalesce(${alias}.on_hand, 0) + coalesce(${alias}.incoming, 0) - coalesce(${alias}.allocated, 0))`;
}
export function shipsNowSql(alias = 'stk'): string {
  return `greatest(coalesce(${alias}.on_hand, 0) - coalesce(${alias}.allocated, 0), 0)`;
}
/** drizzle-flavoured sellable expression for a column set (e.g. s.stock). */
export function sellableExpr(st: { onHand: unknown; incoming: unknown; allocated: unknown }): SQL<number> {
  return sql<number>`(${st.onHand} + ${st.incoming} - ${st.allocated})`;
}

/**
 * #446: non-blocking warning for an on_hand write that leaves more backorder sold than incoming covers
 * (greatest(allocated - on_hand, 0) > incoming, with incoming > 0). null when fine.
 */
export function oversoldBackorderWarning(q: { onHand: number; incoming: number; allocated: number }): string | null {
  if (q.incoming <= 0) return null;
  const sold = minIncoming(q);
  return sold > q.incoming ? `${sold} units are sold on backorder but only ${q.incoming} are incoming; the difference is oversold` : null;
}
