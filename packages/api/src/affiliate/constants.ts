/**
 * Affiliate commission rules shared by routes/admin-affiliate.ts, the welcome
 * mail and the stats helpers (one source, so the mail's "you earn 10%" can
 * never drift from what the dashboards pay).
 *
 * DD parity: affiliate/types.ts COMMISSION_RATE (10%) + COUNTED_STATES (only
 * settled-payment orders earn). SellRight's equivalents of DD's counted
 * states are the two paid states below; cancelled / pending / fully refunded
 * orders never count.
 */
export const COMMISSION_PCT = 10;

/** Order states that earn commission. */
export const COMMISSION_STATES = ['Paid', 'PartiallyRefunded'] as const;

/** Commission basis of one order: merchandise subtotal AFTER discounts (the
 *  affiliate's own coupon included), pre shipping/tax — the same net figure
 *  every total, list and per-order row uses. */
export const commissionBasis = (o: { subtotal: number; discountTotal: number }) => Math.max(o.subtotal - o.discountTotal, 0);

/** Public dashboard order list cap (DD affiliate-stats.service.ts LIMIT 500). */
export const AFFILIATE_ORDER_LIMIT = 500;

/** Public dashboard top-sellers size (DD: LIMIT 3). */
export const AFFILIATE_TOP_SELLERS = 3;

/** Public dashboard throttle (DD resolver: 30 requests / 60s per IP). */
export const AFFILIATE_STATS_RATE = { windowMs: 60 * 1000, max: 30 } as const;

/** Access tokens shorter than this are never valid (DD findAffiliateByToken). */
export const AFFILIATE_MIN_TOKEN_LENGTH = 16;
