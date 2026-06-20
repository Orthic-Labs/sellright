/** Pure cart lifecycle math. Kept env-free so it's unit-testable. */
export function cartExpiry(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}

/** A cart is abandonable when it holds items and has been inactive past the
 *  window. Empty carts are never "abandoned" — they're just idle sessions. */
export function isAbandonable(updatedAt: Date, lineCount: number, now: Date, windowHours: number): boolean {
  if (lineCount <= 0) return false;
  return now.getTime() - updatedAt.getTime() >= windowHours * 60 * 60 * 1000;
}
