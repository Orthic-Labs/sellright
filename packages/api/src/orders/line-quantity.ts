/**
 * Order line quantity semantics (order edits keep the ORIGINAL order).
 *
 * order_line columns, per line (Q = quantity, C = cancelled_qty, R = edit_removed_qty, F = fulfilled_qty):
 *  - `quantity` (Q) is the ORIGINALLY ORDERED count. An order edit never lowers it; it only raises it (adding units that
 *    are not un-cancelled units, see `reconcileLineQuantities`).
 *  - `cancelled_qty` (C) is every unit that will never ship: units removed by an order edit AND units cancelled by a
 *    refund or a cancellation (the refund engine's "unshipped refunded units are cancelled").
 *  - `edit_removed_qty` (R <= C) is the subset of C that an order EDIT removed. Those units are no longer part of the
 *    order's economics: line totals, order totals, tax, loyalty, licences and every display use the BILLED quantity
 *    Q - R. Units cancelled by a refund or cancellation (C - R) stay billed (the order total was never reduced for them).
 *  - open (still to ship) = Q - F - C, unchanged.
 *  - `refunded_qty` keeps counting units refunded through the item/return refund engine against BILLED units. Units
 *    removed by an edit are attributed to their line by `refund_line` rows (source 'order_edit') on the edit's refund
 *    instead; they are outside the billed domain, so they can never be refunded a second time.
 *
 * The "billed view" of a row is the row as it was before edits stopped lowering `quantity`: quantity = Q - R and
 * cancelledQty = C - R. Everything that reasons about money, edits and refunds reads that view, so its logic is
 * unchanged. A row with R = 0 (every row that existed before this change) is its own billed view, byte for byte.
 */

export interface LineQuantityFacts { quantity: number; cancelledQty: number; editRemovedQty?: number | null }

/** Units an order edit removed from this line (0 when never edited). */
export const editRemovedQty = (l: { editRemovedQty?: number | null }): number => l.editRemovedQty ?? 0;

/** The quantity the customer is billed for: ordered less edit-removed. */
export const billedQty = (l: { quantity: number; editRemovedQty?: number | null }): number => l.quantity - editRemovedQty(l);

/** The billed view of a stored row (identity when nothing was edit-removed). Keeps every other column untouched. */
export function billedLine<T extends LineQuantityFacts>(row: T): T {
  const removed = editRemovedQty(row);
  if (removed === 0) return row;
  return { ...row, quantity: row.quantity - removed, cancelledQty: row.cancelledQty - removed };
}
export const billedLines = <T extends LineQuantityFacts>(rows: readonly T[]): T[] => rows.map(billedLine);

export interface StoredLineQuantities { quantity: number; cancelledQty: number; editRemovedQty: number }
export interface LineQuantityChange extends StoredLineQuantities {
  /** Units this change newly removed (billed went down). */
  removed: number;
  /** Previously edit-removed units this change brought back (billed went up and R was positive). */
  restored: number;
  /** Brand-new units this change added on top of the original order (billed went up beyond R). */
  added: number;
}

/**
 * Map a line's new BILLED quantity to the stored columns.
 *  - billed goes down by d: the d units are cancelled and recorded as edit-removed; `quantity` (ordered) is untouched.
 *  - billed goes up by d: UN-CANCEL FIRST. Up to R edit-removed units come back (R and C both drop), because they are
 *    units of the original order that never shipped and still belong to this line; only the rest raises `quantity`.
 *    Refund-cancelled units (C - R) are never un-cancelled: they were refunded or cancelled for good.
 * The caller has already ensured billedAfter >= fulfilled + (C - R) (the locked units).
 */
export function reconcileLineQuantities(current: StoredLineQuantities, billedAfter: number): LineQuantityChange {
  const billedBefore = current.quantity - current.editRemovedQty;
  if (billedAfter < billedBefore) {
    const removed = billedBefore - billedAfter;
    return { quantity: current.quantity, cancelledQty: current.cancelledQty + removed, editRemovedQty: current.editRemovedQty + removed, removed, restored: 0, added: 0 };
  }
  if (billedAfter > billedBefore) {
    const grow = billedAfter - billedBefore;
    const restored = Math.min(grow, current.editRemovedQty);
    const added = grow - restored;
    return { quantity: current.quantity + added, cancelledQty: current.cancelledQty - restored, editRemovedQty: current.editRemovedQty - restored, removed: 0, restored, added };
  }
  return { ...current, removed: 0, restored: 0, added: 0 };
}
