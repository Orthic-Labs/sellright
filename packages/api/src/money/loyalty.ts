/**
 * Loyalty points math. PURE — no I/O. Points are integers; money is integer
 * cents. The ledger (loyalty/ledger.ts) is the only writer; this module only
 * decides numbers.
 *
 * Program settings (store.config.loyalty):
 *   enabled                     default false — nothing earns or redeems until on
 *   earnRatePerDollar           points earned per $1 of eligible spend
 *   pointsPerDollarOff          points needed for $1 off
 *   minRedeemPoints             smallest redemption accepted
 *   maxRedeemPercentOfSubtotal  optional cap (1–100) on the discount, as a %
 *                               of the post-promotion merchandise subtotal
 *   expiryDays                  optional lifetime of earned points (null = never)
 */
import { z } from 'zod';

export const LoyaltySettingsSchema = z.object({
  enabled: z.boolean(),
  earnRatePerDollar: z.number().int().min(0).max(10_000),
  pointsPerDollarOff: z.number().int().min(1).max(1_000_000),
  minRedeemPoints: z.number().int().min(0).max(100_000_000),
  maxRedeemPercentOfSubtotal: z.number().int().min(1).max(100).nullable(),
  expiryDays: z.number().int().min(1).max(36_500).nullable(),
}).strict();
export type LoyaltySettings = z.infer<typeof LoyaltySettingsSchema>;

export const DEFAULT_LOYALTY_SETTINGS: LoyaltySettings = {
  enabled: false,
  earnRatePerDollar: 1,
  pointsPerDollarOff: 100,
  minRedeemPoints: 0,
  maxRedeemPercentOfSubtotal: null,
  expiryDays: null,
};

/** Read store.config.loyalty. A missing or malformed block is the default
 *  (disabled) program — fail closed, never a half-configured one. */
export function loyaltySettingsFromConfig(config: unknown): LoyaltySettings {
  const raw = (config as { loyalty?: unknown } | null | undefined)?.loyalty;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LOYALTY_SETTINGS };
  const parsed = LoyaltySettingsSchema.safeParse({ ...DEFAULT_LOYALTY_SETTINGS, ...(raw as Record<string, unknown>) });
  return parsed.success ? parsed.data : { ...DEFAULT_LOYALTY_SETTINGS };
}

/** Points earned on `eligibleCents` (merchandise after every discount,
 *  excluding shipping and tax). Floors — partial points are never granted. */
export function pointsEarned(eligibleCents: number, earnRatePerDollar: number): number {
  if (!(eligibleCents > 0) || !(earnRatePerDollar > 0)) return 0;
  return Math.floor((Math.floor(eligibleCents) * earnRatePerDollar) / 100);
}

/** Cents off that `points` buy (floored to whole cents). */
export function pointsToCents(points: number, pointsPerDollarOff: number): number {
  if (!(points > 0) || !(pointsPerDollarOff > 0)) return 0;
  return Math.floor((points * 100) / pointsPerDollarOff);
}

/** Smallest point count that buys `cents` off. */
export function centsToPoints(cents: number, pointsPerDollarOff: number): number {
  if (!(cents > 0)) return 0;
  return Math.ceil((cents * pointsPerDollarOff) / 100);
}

export type RedeemRejection = 'disabled' | 'not_signed_in' | 'below_minimum' | 'insufficient_balance' | 'nothing_to_discount';
export type RedeemPlan =
  | { ok: true; points: number; discountCents: number }
  | { ok: false; reason: RedeemRejection };

/**
 * Decide a redemption. `requestedPoints` is the MOST the shopper wants to
 * spend; the plan never spends more than the balance allows, never discounts
 * more than the (capped) discountable subtotal, and charges only the points
 * that the granted discount actually costs (no wasted points on a cap).
 * A request above the available balance is rejected, not silently clamped —
 * the server never spends points the shopper didn't see.
 */
export function planRedemption(input: {
  settings: LoyaltySettings;
  requestedPoints: number;
  availablePoints: number;
  discountableCents: number; // merchandise subtotal after promotions, pre-tax
}): RedeemPlan {
  const { settings: cfg } = input;
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  const requested = Math.floor(input.requestedPoints);
  if (!(requested > 0)) return { ok: false, reason: 'below_minimum' };
  if (requested > Math.max(0, input.availablePoints)) return { ok: false, reason: 'insufficient_balance' };
  if (requested < cfg.minRedeemPoints) return { ok: false, reason: 'below_minimum' };
  const base = Math.max(0, Math.floor(input.discountableCents));
  const cap = cfg.maxRedeemPercentOfSubtotal == null ? base : Math.floor((base * cfg.maxRedeemPercentOfSubtotal) / 100);
  const discountCents = Math.min(pointsToCents(requested, cfg.pointsPerDollarOff), cap);
  if (discountCents <= 0) return { ok: false, reason: 'nothing_to_discount' };
  const points = Math.min(requested, centsToPoints(discountCents, cfg.pointsPerDollarOff));
  if (points < cfg.minRedeemPoints) return { ok: false, reason: 'below_minimum' };
  return { ok: true, points, discountCents };
}

/**
 * Cumulative proportional share: how much of `total` should have been
 * reversed once `num`/`den` of the order's money has been refunded. Callers
 * post (target − alreadyPosted) so repeated partial refunds converge on
 * exactly `total` at a full refund, with no rounding drift.
 */
export function proportionalTarget(total: number, num: number, den: number): number {
  if (!(total > 0) || !(den > 0) || !(num > 0)) return 0;
  if (num >= den) return total;
  return Math.round((total * num) / den);
}

export interface LedgerEntryLike {
  kind: string;
  points: number;
  expiresAt: Date | null;
  createdAt: Date;
}

/**
 * FIFO lot accounting for expiry. Credits open lots (with their expiry);
 * debits consume the soonest-expiring still-valid lots first (then
 * never-expiring lots). An `expire` debit consumes lots that had already
 * expired when it was posted. Returns the points that have expired as of
 * `now` but were not yet written off by an `expire` entry — i.e. the amount
 * the next `expire` posting must remove, and what a balance read must hide.
 * Entries must be in posting order.
 */
export function unpostedExpiredPoints(entries: LedgerEntryLike[], now: Date): number {
  type Lot = { remaining: number; expiresAt: number | null };
  const lots: Lot[] = [];
  const consume = (amount: number, at: number, expiredOnly: boolean) => {
    let left = amount;
    const pick = (pred: (l: Lot) => boolean) => lots
      .filter((l) => l.remaining > 0 && pred(l))
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
    const passes = expiredOnly
      ? [pick((l) => l.expiresAt != null && l.expiresAt <= at)]
      : [pick((l) => l.expiresAt == null || l.expiresAt > at), pick(() => true)];
    for (const pass of passes) {
      for (const lot of pass) {
        if (left <= 0) return;
        const take = Math.min(lot.remaining, left);
        lot.remaining -= take;
        left -= take;
      }
    }
  };
  for (const e of entries) {
    const at = e.createdAt.getTime();
    if (e.points > 0) lots.push({ remaining: e.points, expiresAt: e.expiresAt ? e.expiresAt.getTime() : null });
    else if (e.points < 0) consume(-e.points, at, e.kind === 'expire');
  }
  const t = now.getTime();
  return lots.reduce((n, l) => n + (l.expiresAt != null && l.expiresAt <= t ? l.remaining : 0), 0);
}

/** Merchandise base that earns points: subtotal after ALL discounts (promo +
 *  points), with any included item tax removed. Shipping never earns. */
export function earnableCents(input: { subtotal: number; discountTotal: number; taxRate: number; taxInclusive: boolean }): number {
  const discounted = Math.max(0, input.subtotal - input.discountTotal);
  if (!input.taxInclusive || input.taxRate <= 0) return discounted;
  return Math.round((discounted * 10000) / (10000 + input.taxRate));
}
