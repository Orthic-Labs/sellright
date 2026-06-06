/**
 * Automatic discounts (Shopify-parity): store-configured promotions with a NULL
 * code that apply without the shopper entering anything. v1 applies the single
 * best eligible automatic when no explicit coupon is in play (the totals engine
 * carries one promotion), matching the single-discount model. Pure — no I/O; the
 * caller supplies the candidate rows and enforces usage limits/locks downstream.
 */
import { evaluateCoupon, type CouponContext } from './coupon.js';
import type { Promotion } from './totals.js';

export type AutoPromoRow = {
  id: string;
  type: Promotion['type'];
  value: number; // percentage: 0–100; fixed: cents
  conditions: unknown;
  priority: number;
};

/** Discount (cents) a promo yields on a subtotal — for RANKING only. */
function rankDiscount(type: Promotion['type'], value: number, subtotal: number): number {
  if (type === 'percentage') return Math.round((subtotal * value) / 100);
  if (type === 'fixed') return Math.min(value, subtotal);
  return 0; // free_shipping ranks at 0 here (value is in shipping, not subtotal)
}

/**
 * Pick the best eligible automatic promotion: highest `priority`, tie-broken by
 * the larger discount (most shopper-favourable, deterministic). Returns the
 * winning row (so the caller can still enforce id/limits) or null.
 */
export function selectAutomaticPromotion(rows: AutoPromoRow[], ctx: CouponContext): AutoPromoRow | null {
  const eligible = rows
    .filter((r) => evaluateCoupon({ type: r.type, value: r.value, conditions: r.conditions }, ctx).valid)
    .map((r) => ({ r, disc: rankDiscount(r.type, r.value, ctx.subtotal) }))
    .sort((a, b) => b.r.priority - a.r.priority || b.disc - a.disc);
  return eligible[0]?.r ?? null;
}
