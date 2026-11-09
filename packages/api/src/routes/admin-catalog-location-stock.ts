/**
 * Location stock arithmetic (pure).
 *
 * Semantics: a location's on-hand figure is a per-location count. Sales reduce
 * the sellable aggregate (`stock.on_hand`) but not the location rows, so the
 * two can legitimately differ and the aggregate must never be recomputed from
 * the location sum. A change to one location's figure is applied to the
 * aggregate as a DELTA (new location value minus the previous one; the previous
 * value is 0 when the location row did not exist). The aggregate never drops
 * below 0 or below what is already allocated to open orders.
 */
export type LocationSetResult = {
  /** New `stock.on_hand`. */
  onHand: number;
  /** Signed change actually applied to `stock.on_hand` (what the movement row records). */
  appliedDelta: number;
  /** True when the requested delta was cut short by the 0 / allocated floor. */
  clamped: boolean;
};

export function applyLocationDelta(args: { previousLocation: number; newLocation: number; onHand: number; allocated: number }): LocationSetResult {
  const requested = args.newLocation - args.previousLocation;
  const floor = Math.max(0, args.allocated);
  const target = args.onHand + requested;
  // If the aggregate is already below the floor (should not happen), a negative delta changes nothing.
  const onHand = requested >= 0 ? target : Math.max(target, Math.min(floor, args.onHand));
  const appliedDelta = onHand - args.onHand;
  return { onHand, appliedDelta, clamped: appliedDelta !== requested };
}
