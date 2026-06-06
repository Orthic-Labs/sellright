import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { calculateOrderTotals, type Promotion } from '../money/totals.js';
import { evaluateCoupon } from '../money/coupon.js';
import { bearer, resolveCustomer } from '../auth/session.js';

async function store(c: { req: { header: (k: string) => string | undefined } }): Promise<StoreCtx> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  const found = await resolveStore(slug);
  if (!found) throw new Error(`unknown store: ${slug}`);
  return found;
}

/** Price selection (rulebook §2): preorder > sale > base. */
function selectUnitPrice(v: { price: number; salePrice: number | null; isPreOrder: boolean; preOrderPrice: number | null }): number {
  if (v.isPreOrder && v.preOrderPrice != null) return v.preOrderPrice;
  if (v.salePrice != null) return v.salePrice;
  return v.price;
}

const EstimateItem = z.object({ sku: z.string(), quantity: z.number().int().min(1) });
const LineOut = z.object({
  sku: z.string(), name: z.string(), unitPrice: z.number().int(), quantity: z.number().int(),
  lineSubtotal: z.number().int(), lineDiscount: z.number().int(), lineTotal: z.number().int(),
  available: z.boolean(),
});
const EstimateOut = z.object({
  currency: z.string(),
  lines: z.array(LineOut),
  subtotal: z.number().int(), discountTotal: z.number().int(), shippingTotal: z.number().int(),
  taxTotal: z.number().int(), grandTotal: z.number().int(),
  unavailable: z.array(z.string()),
  coupon: z.object({ code: z.string(), applied: z.boolean(), reason: z.string().optional() }).nullable(),
});

export const cart = new OpenAPIHono();

// POST /v1/shop/cart/estimate — server re-prices the cart (never trusts client prices)
cart.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/cart/estimate',
    summary: 'Estimate cart totals (server-priced)',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ items: z.array(EstimateItem).min(1), shipping: z.number().int().min(0).default(0), couponCode: z.string().optional() }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Estimate', content: { 'application/json': { schema: EstimateOut } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { items, shipping, couponCode } = c.req.valid('json');
    const token = bearer(c.req.header('authorization'));
    const skus = [...new Set(items.map((i) => i.sku))];

    const result = await withStore(st.id, async (tx) => {
      const variants = await tx
        .select({
          sku: s.productVariant.sku, name: s.productVariant.name, price: s.productVariant.price,
          salePrice: s.productVariant.salePrice, isPreOrder: s.productVariant.isPreOrder,
          preOrderPrice: s.productVariant.preOrderPrice, enabled: s.productVariant.enabled,
        })
        .from(s.productVariant)
        .where(and(inArray(s.productVariant.sku, skus), isNull(s.productVariant.deletedAt)));
      const bySku = new Map(variants.map((v) => [v.sku, v]));

      const unavailable: string[] = [];
      const priced = items.map((i) => {
        const v = bySku.get(i.sku);
        const available = !!v && v.enabled;
        if (!available) unavailable.push(i.sku);
        const unitPrice = v ? selectUnitPrice(v) : 0;
        return { sku: i.sku, name: v?.name ?? '(unavailable)', unitPrice, quantity: i.quantity, available };
      });

      // --- coupon (single, server-validated) ---
      let promotion: Promotion | undefined;
      let coupon: { code: string; applied: boolean; reason?: string } | null = null;
      if (couponCode) {
        const now = new Date();
        const [promo] = await tx
          .select()
          .from(s.promotion)
          .where(and(
            eq(s.promotion.code, couponCode),
            eq(s.promotion.enabled, true),
            or(isNull(s.promotion.startsAt), lte(s.promotion.startsAt, now)),
            or(isNull(s.promotion.endsAt), gte(s.promotion.endsAt, now)),
          ))
          .limit(1);
        if (!promo) {
          coupon = { code: couponCode, applied: false, reason: 'invalid or expired code' };
        } else {
          const presubtotal = priced.filter((p) => p.available).reduce((a, p) => a + p.unitPrice * p.quantity, 0);
          const activeVerifications = token ? (await resolveCustomer(tx, token))?.activeVerifications ?? [] : [];
          const ev = evaluateCoupon({ type: promo.type, value: promo.value, conditions: promo.conditions }, { subtotal: presubtotal, activeVerifications });
          if (ev.valid && ev.promotion) { promotion = ev.promotion; coupon = { code: couponCode, applied: true }; }
          else coupon = { code: couponCode, applied: false, reason: ev.reason };
        }
      }

      const totals = calculateOrderTotals({
        lines: priced.filter((p) => p.available).map((p) => ({ unitPrice: p.unitPrice, quantity: p.quantity })),
        shipping, taxRate: st.taxRate, shippingTaxable: st.shippingTaxable, promotion,
      });

      // Re-attach per-line breakdown (only available lines were costed).
      let idx = 0;
      const lines = priced.map((p) => {
        if (!p.available) return { ...p, lineSubtotal: 0, lineDiscount: 0, lineTotal: 0 };
        const t = totals.lines[idx++]!;
        return { ...p, lineSubtotal: t.lineSubtotal, lineDiscount: t.lineDiscount, lineTotal: t.lineTotal };
      });

      return {
        currency: st.currency, lines,
        subtotal: totals.subtotal, discountTotal: totals.discountTotal, shippingTotal: totals.shippingTotal,
        taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, unavailable, coupon,
      };
    });

    return c.json(result, 200);
  },
);
