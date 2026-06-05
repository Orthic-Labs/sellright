import type { Promotion } from './totals.js';

/** Single-coupon v1 (rulebook §5/§6). Evaluates DD's condition set against the
 *  cart; facet conditions are deferred (checkout remains authoritative). */
export interface CouponContext {
  subtotal: number; // cents, pre-discount
  activeVerifications: string[]; // customer's SheerID categories (may be empty)
}

export interface CouponEval {
  valid: boolean;
  reason?: string;
  promotion?: Promotion;
}

interface Condition {
  code: string;
  args?: Array<{ name: string; value: string }>;
}

const arg = (c: Condition, name: string): string | undefined => c.args?.find((a) => a.name === name)?.value;

export function evaluateCoupon(
  promo: { type: Promotion['type']; value: number; conditions: unknown },
  ctx: CouponContext,
): CouponEval {
  const conditions: Condition[] = Array.isArray(promo.conditions) ? (promo.conditions as Condition[]) : [];
  for (const cond of conditions) {
    switch (cond.code) {
      case 'minimum_order_amount': {
        const amount = Number(arg(cond, 'amount') ?? 0);
        if (ctx.subtotal < amount) return { valid: false, reason: `minimum order of ${(amount / 100).toFixed(2)} not met` };
        break;
      }
      case 'verified_customer': {
        let categories: string[] = [];
        try { categories = JSON.parse(arg(cond, 'categories') ?? '[]'); } catch { /* ignore */ }
        if (!ctx.activeVerifications.some((v) => categories.includes(v))) return { valid: false, reason: 'requires verified status' };
        break;
      }
      case 'at_least_n_with_facets':
        // Can't be evaluated against a local cart — checkout is authoritative (rulebook §5).
        break;
      default:
        return { valid: false, reason: `unsupported condition: ${cond.code}` };
    }
  }
  return { valid: true, promotion: { type: promo.type, value: promo.value } };
}
