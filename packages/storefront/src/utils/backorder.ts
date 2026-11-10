// #446 backorder copy and fail-closed readers. Display only: whether a unit is a backorder unit always comes from a live read
// (stock read, cart read, order read), never from the manifest or the cached shell. The ship label text comes only from the API; this
// module adds no dates and no promises. Every read treats an absent field as "not backorder".

/** Shown on a backorder line whose variant has no label. */
export const BACKORDER_FALLBACK_LABEL = 'Ships later';
/** The one order-level sentence, shown when any line of the cart / order is a backorder line. */
export const BACKORDER_ORDER_NOTE = 'Your whole order ships together when these items arrive.';

/** A label from the API, trimmed; null when empty or not a string. */
export const cleanLabel = (label: unknown): string | null => (typeof label === 'string' && label.trim() ? label.trim() : null);

/** The label a backorder line shows: the API's, else "Ships later". */
export const shipLabelOf = (label: unknown): string => cleanLabel(label) ?? BACKORDER_FALLBACK_LABEL;

export type BackorderLineFacts = { backorder?: boolean | null; shipLabel?: string | null };

/** True only for an explicit `backorder === true`. */
export const isBackorderLine = (line: BackorderLineFacts | null | undefined): boolean => line?.backorder === true;

/** The per-line notice text, or null when the line is not a backorder line. */
export const lineBackorderNotice = (line: BackorderLineFacts | null | undefined): string | null =>
  isBackorderLine(line) ? shipLabelOf(line?.shipLabel) : null;

/** Whether any line of a cart or order is a backorder line. */
export const hasBackorderLine = (lines: ReadonlyArray<BackorderLineFacts> | null | undefined): boolean =>
  !!lines && lines.some((l) => isBackorderLine(l));

/** The product page's notice for a live variant: shown only while the live read says nothing ships now (`backorder === true`). */
export interface VariantBackorderFacts { inStock?: boolean; enabled?: boolean; backorder?: boolean; shipsNowQuantity?: number | null; backorderLabel?: string | null }

/** Backorder state of a variant from its LIVE fields. Fail closed: not in stock (or unchecked) is never backorder. */
export function variantBackorder(v: VariantBackorderFacts | null | undefined): { backorder: boolean; label: string } | null {
  if (!v || v.inStock !== true || v.enabled === false || v.backorder !== true) return null;
  return { backorder: true, label: shipLabelOf(v.backorderLabel) };
}

/** When the chosen quantity exceeds what ships now (>0): everything ships together, with the label. */
export function shipTogetherNote(v: VariantBackorderFacts | null | undefined, quantity: number): string | null {
  if (!v || v.inStock !== true || v.enabled === false || v.backorder === true) return null;
  const now = v.shipsNowQuantity;
  if (typeof now !== 'number' || !Number.isFinite(now) || now <= 0 || !Number.isInteger(quantity) || quantity <= now) return null;
  const label = cleanLabel(v.backorderLabel);
  return label ? `All ${quantity} ship together. ${label}` : `All ${quantity} ship together when the rest arrives.`;
}

/** The notice the PDP shows for the selected variant and chosen quantity (null = nothing). */
export function pdpBackorderNotice(v: VariantBackorderFacts | null | undefined, quantity = 1): string | null {
  return variantBackorder(v)?.label ?? shipTogetherNote(v, quantity);
}

/** Whether an order has a backorder line: the order's own flag, or any line's (either one is enough; absent = false). */
export const orderHasBackorder = (order: { hasBackorder?: boolean | null; lines?: ReadonlyArray<BackorderLineFacts> | null } | null | undefined): boolean =>
  !!order && (order.hasBackorder === true || hasBackorderLine(order.lines));

/** A trust-strip item that promises a shipping speed ("Ships in 1-2 business days", "Ships within 24 hours"). */
const SHIPS_FAST_CLAIM = /\bships?\b[^.]*\b(?:hours?|days?|today|tomorrow)\b/i;

/**
 * The cart trust strip for this cart: a shipping-speed promise is dropped while any line ships later, so the strip never
 * says "Ships in 1-2 business days" above a line that says "Ships in 3 weeks". Every other item (returns, payment) stays.
 */
export const trustStripFor = (items: ReadonlyArray<string>, lines: ReadonlyArray<BackorderLineFacts> | null | undefined): string[] =>
  hasBackorderLine(lines) ? items.filter((t) => !SHIPS_FAST_CLAIM.test(t)) : [...items];

