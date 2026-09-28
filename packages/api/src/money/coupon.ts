import type { Promotion } from './totals.js';

/** Single-coupon v1 (rulebook §5/§6). Evaluates DD's condition set against the
 *  cart. Item-targeting conditions (collections/products/tags) are native —
 *  no facet/metafield lookup. Pure — no I/O; callers that need to resolve a
 *  variant's productId/tags/collectionIds from the DB use
 *  `money/coupon-context.ts`. */
export interface CouponContext {
  subtotal: number; // cents, pre-discount
  activeVerifications: string[]; // customer's SheerID categories (may be empty)
  items?: Array<{ quantity: number; productId: string; tags: string[]; collectionIds: string[] }>;
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

function parseStringArray(raw: string | undefined): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '[]');
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed.map(String) : null;
}

export function evaluateCoupon(
  promo: { type: Promotion['type']; value: number; conditions: unknown; freeShipping?: boolean },
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
      // ── native item-targeting conditions (replaces the old, source-facet-
      // based `at_least_n_with_facets`) ────────────────────────────────────
      case 'at_least_n_in_collections': {
        const collectionIds = parseStringArray(arg(cond, 'collectionIds'));
        const minimum = Number(arg(cond, 'minimum') ?? 1);
        if (!collectionIds || !Number.isSafeInteger(minimum) || minimum < 1 || !ctx.items) {
          return { valid: false, reason: 'requires eligible products' };
        }
        const required = new Set(collectionIds);
        const matched = ctx.items
          .filter((item) => item.collectionIds.some((id) => required.has(id)))
          .reduce((sum, item) => sum + item.quantity, 0);
        if (matched < minimum) return { valid: false, reason: 'requires eligible products' };
        break;
      }
      case 'at_least_n_products': {
        const productIds = parseStringArray(arg(cond, 'productIds'));
        const minimum = Number(arg(cond, 'minimum') ?? 1);
        if (!productIds || !Number.isSafeInteger(minimum) || minimum < 1 || !ctx.items) {
          return { valid: false, reason: 'requires eligible products' };
        }
        const required = new Set(productIds);
        const matched = ctx.items
          .filter((item) => required.has(item.productId))
          .reduce((sum, item) => sum + item.quantity, 0);
        if (matched < minimum) return { valid: false, reason: 'requires eligible products' };
        break;
      }
      case 'at_least_n_with_tags': {
        const tags = parseStringArray(arg(cond, 'tags'));
        const minimum = Number(arg(cond, 'minimum') ?? 1);
        if (!tags || !Number.isSafeInteger(minimum) || minimum < 1 || !ctx.items) {
          return { valid: false, reason: 'requires eligible products' };
        }
        const required = new Set(tags);
        const matched = ctx.items
          .filter((item) => item.tags.some((t) => required.has(t)))
          .reduce((sum, item) => sum + item.quantity, 0);
        if (matched < minimum) return { valid: false, reason: 'requires eligible products' };
        break;
      }
      default:
        return { valid: false, reason: `unsupported condition: ${cond.code}` };
    }
  }
  return { valid: true, promotion: { type: promo.type, value: promo.value, freeShipping: promo.freeShipping } };
}
