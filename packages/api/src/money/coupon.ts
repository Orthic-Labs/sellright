import type { Promotion } from './totals.js';

/** Single-coupon v1 (rulebook §5/§6). Evaluates DD's condition set against the
 *  cart; facet conditions are deferred (checkout remains authoritative). */
export interface CouponContext {
  subtotal: number; // cents, pre-discount
  activeVerifications: string[]; // customer's SheerID categories (may be empty)
  items?: Array<{ quantity: number; facetValueIds: string[] }>;
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
      case 'at_least_n_with_facets': {
        let facets: unknown;
        try { facets = JSON.parse(arg(cond, 'facets') ?? '[]'); } catch { return { valid: false, reason: 'invalid facet condition' }; }
        const minimum = Number(arg(cond, 'minimum') ?? 1);
        if (!Array.isArray(facets) || !Number.isSafeInteger(minimum) || minimum < 1 || !ctx.items) {
          return { valid: false, reason: 'requires eligible products' };
        }
        const required = facets.map(String);
        const matched = ctx.items.filter(item => required.every(id => item.facetValueIds.includes(id)))
          .reduce((sum, item) => sum + item.quantity, 0);
        if (matched < minimum) return { valid: false, reason: 'requires eligible products' };
        break;
      }
      default:
        return { valid: false, reason: `unsupported condition: ${cond.code}` };
    }
  }
  return { valid: true, promotion: { type: promo.type, value: promo.value } };
}

export function productFacetIds(metafields: unknown): string[] {
  const ids = (metafields as { facetValueIds?: unknown } | null)?.facetValueIds;
  return Array.isArray(ids) ? ids.map(String) : [];
}
