/** Pure cart lifecycle math. Kept env-free so it's unit-testable. */
export function cartExpiry(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}

/**
 * Cart lifecycle config (CART-04), resolved per store from
 * `store.config.cart` with deployment defaults (env) as the fallback.
 *
 *   abandonAfterHours — inactivity window: an active cart with lines and no
 *     writes past this is flagged 'abandoned' (analytics/recovery event).
 *   ttlDays           — hard TTL written to cart.expires_at on every mutation;
 *     the cleanup job deletes only EXPIRED + EMPTY + ACTIVE carts.
 *   retentionDays     — how long an ABANDONED cart is retained for recovery /
 *     analytics before cleanup purges it. Falls back to the deployment
 *     default (env CART_RETENTION_DAYS — owner decision 2026-09-24: 24h /
 *     1 day) when a store sets nothing; pass `null` explicitly as that
 *     default to retain indefinitely instead. While the row exists and is
 *     not converted, the cart is resumable by its bearer token. Converted
 *     carts are never purged — converted_order_id anchors payment recovery
 *     on the order.
 *
 * An email captured on a cart is NOT verified account ownership, so retention
 * never keys on email/customer presence — only on status + age.
 */
export interface CartLifecycleConfig {
  abandonAfterHours: number;
  ttlDays: number;
  retentionDays: number | null;
}

export function cartLifecycleFromConfig(
  config: unknown,
  defaults: { abandonAfterHours: number; ttlDays: number; retentionDays: number | null },
): CartLifecycleConfig {
  const c = (config as { cart?: Record<string, unknown> } | null | undefined)?.cart ?? {};
  // Positive finite numbers only — a 0 retention window would mean "purge
  // immediately", which must never be honored by accident.
  const pos = (v: unknown): number | undefined =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  return {
    abandonAfterHours: pos(c.abandonAfterHours) ?? defaults.abandonAfterHours,
    ttlDays: pos(c.ttlDays) ?? defaults.ttlDays,
    retentionDays: pos(c.retentionDays) ?? defaults.retentionDays,
  };
}

/** A cart is abandonable when it holds items and has been inactive past the
 *  window. Empty carts are never "abandoned" — they're just idle sessions. */
export function isAbandonable(updatedAt: Date, lineCount: number, now: Date, windowHours: number): boolean {
  if (lineCount <= 0) return false;
  return now.getTime() - updatedAt.getTime() >= windowHours * 60 * 60 * 1000;
}
