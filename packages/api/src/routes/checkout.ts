import { randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { calculateOrderTotals, type Promotion } from '../money/totals.js';
import { evaluateCoupon } from '../money/coupon.js';

async function store(c: { req: { header: (k: string) => string | undefined } }): Promise<StoreCtx> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  const found = await resolveStore(slug);
  if (!found) throw new Error(`unknown store: ${slug}`);
  return found;
}

function selectUnitPrice(v: { price: number; salePrice: number | null; isPreOrder: boolean; preOrderPrice: number | null }): number {
  if (v.isPreOrder && v.preOrderPrice != null) return v.preOrderPrice;
  if (v.salePrice != null) return v.salePrice;
  return v.price;
}

/**
 * Canonical address shape for the order snapshot — matches the `address` table
 * (line1/line2/country), so the snapshot and the saved-address book agree.
 * Accepts either the canonical keys OR the storefront's Vendure-ish ones
 * (streetLine1/countryCode) and maps to canonical. Unknown extras are dropped.
 */
function normalizeAddress(a: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!a) return null;
  const g = (k: string) => (a[k] != null ? String(a[k]) : null);
  return {
    fullName: g('fullName') ?? ([g('firstName'), g('lastName')].filter(Boolean).join(' ') || null),
    line1: g('line1') ?? g('streetLine1'),
    line2: g('line2') ?? g('streetLine2'),
    city: g('city'),
    province: g('province') ?? g('state'),
    postalCode: g('postalCode') ?? g('postal_code') ?? g('zip'),
    country: g('country') ?? g('countryCode'),
    phone: g('phone') ?? g('phoneNumber'),
  };
}

const orderCode = () => ('SR' + randomUUID().replace(/-/g, '').slice(0, 10)).toUpperCase();

export const checkout = new OpenAPIHono();

// POST /v1/shop/checkout — create an order from a cart (PendingPayment).
// Re-prices server-side, RE-VALIDATES the coupon server-side (never trusts the
// client), allocates stock atomically (no oversell), persists order + snapshot
// lines + promotion linkage/usage. Payment is a separate step on the order.
checkout.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/checkout',
    summary: 'Create an order from a cart',
    request: {
      headers: z.object({ 'idempotency-key': z.string().optional() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(z.object({ sku: z.string(), quantity: z.number().int().min(1) })).min(1),
              shipping: z.number().int().min(0).default(0),
              couponCode: z.string().optional(),
              email: z.string().email().optional(),
              shippingAddress: z.record(z.string(), z.unknown()).optional(),
              billingAddress: z.record(z.string(), z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Order created',
        content: { 'application/json': { schema: z.object({ code: z.string(), state: z.string(), grandTotal: z.number().int(), discountTotal: z.number().int(), currency: z.string(), couponApplied: z.boolean() }) } },
      },
      409: { description: 'Out of stock / unavailable', content: { 'application/json': { schema: z.object({ error: z.string(), skus: z.array(z.string()) }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const body = c.req.valid('json');
    const idemKey = c.req.header('idempotency-key') || null;
    const skus = [...new Set(body.items.map((i) => i.sku))];

    type Result = { blocked: string[] } | { code: string; grandTotal: number; discountTotal: number; couponApplied: boolean; replay?: boolean };
    const out = await withStore(st.id, async (tx): Promise<Result> => {
      // Idempotency: same key -> the same order (also guarded by a unique index).
      if (idemKey) {
        const [existing] = await tx
          .select({ code: s.order.code, grandTotal: s.order.grandTotal, discountTotal: s.order.discountTotal })
          .from(s.order)
          .where(eq(s.order.idempotencyKey, idemKey))
          .limit(1);
        if (existing) return { code: existing.code, grandTotal: existing.grandTotal, discountTotal: existing.discountTotal, couponApplied: existing.discountTotal > 0, replay: true };
      }

      const variants = await tx
        .select()
        .from(s.productVariant)
        .where(and(inArray(s.productVariant.sku, skus), isNull(s.productVariant.deletedAt)));
      const bySku = new Map(variants.map((v) => [v.sku, v]));

      // Validate availability + allocate stock atomically (skip stock for pre-orders).
      const blocked: string[] = [];
      for (const i of body.items) {
        const v = bySku.get(i.sku);
        if (!v || !v.enabled) { blocked.push(i.sku); continue; }
        if (v.isPreOrder) continue;
        const res = await tx.execute(sql`
          UPDATE "stock" SET allocated = allocated + ${i.quantity}
          WHERE variant_id = ${v.id} AND store_id = ${st.id} AND (on_hand - allocated) >= ${i.quantity}`);
        if ((res as { rowCount: number | null }).rowCount !== 1) blocked.push(i.sku);
      }
      if (blocked.length) return { blocked };

      const priced = body.items.map((i) => {
        const v = bySku.get(i.sku)!;
        return { v, qty: i.quantity, unitPrice: selectUnitPrice(v) };
      });

      // Resolve the customer (id + verification categories) for coupon rules.
      const customer = body.email
        ? (await tx.select({ id: s.customer.id, activeVerifications: s.customer.activeVerifications }).from(s.customer).where(eq(s.customer.email, body.email)).limit(1))[0]
        : undefined;
      const customerId = customer?.id ?? null;

      // ── Coupon: re-validate server-side + enforce usage limits ───────────────
      let promotion: Promotion | undefined;
      let promoId: string | null = null;
      if (body.couponCode) {
        const now = new Date();
        const [promo] = await tx
          .select()
          .from(s.promotion)
          .where(and(
            eq(s.promotion.code, body.couponCode),
            eq(s.promotion.enabled, true),
            or(isNull(s.promotion.startsAt), lte(s.promotion.startsAt, now)),
            or(isNull(s.promotion.endsAt), gte(s.promotion.endsAt, now)),
          ))
          .limit(1);
        if (promo) {
          const globalOk = promo.usageLimit == null || promo.usedCount < promo.usageLimit;
          let perCustomerOk = true;
          if (promo.perCustomerUsageLimit != null && customerId) {
            const usedRows = await tx
              .select({ n: count() })
              .from(s.promotionUsage)
              .where(and(eq(s.promotionUsage.promotionId, promo.id), eq(s.promotionUsage.customerId, customerId)));
            perCustomerOk = (usedRows[0]?.n ?? 0) < promo.perCustomerUsageLimit;
          }
          const presubtotal = priced.reduce((a, p) => a + p.unitPrice * p.qty, 0);
          const ev = evaluateCoupon(
            { type: promo.type, value: promo.value, conditions: promo.conditions },
            { subtotal: presubtotal, activeVerifications: customer?.activeVerifications ?? [] },
          );
          // Apply only if valid AND within limits; else proceed at full price
          // (server is authoritative — the returned grandTotal is the truth).
          if (globalOk && perCustomerOk && ev.valid && ev.promotion) { promotion = ev.promotion; promoId = promo.id; }
        }
      }

      const totals = calculateOrderTotals({
        lines: priced.map((p) => ({ unitPrice: p.unitPrice, quantity: p.qty })),
        shipping: body.shipping, taxRate: st.taxRate, promotion,
      });

      const orderId = randomUUID();
      const code = orderCode();
      await tx.insert(s.order).values({
        id: orderId, storeId: st.id, code, customerId, state: 'PendingPayment', currency: st.currency,
        idempotencyKey: idemKey, promotionId: promoId,
        subtotal: totals.subtotal, discountTotal: totals.discountTotal, shippingTotal: totals.shippingTotal,
        taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
        isPreOrder: priced.some((p) => p.v.isPreOrder),
        shippingAddress: normalizeAddress(body.shippingAddress), billingAddress: normalizeAddress(body.billingAddress),
      });
      await tx.insert(s.orderLine).values(
        priced.map((p, idx) => ({
          storeId: st.id, orderId, variantId: p.v.id, variantSku: p.v.sku, variantName: p.v.name,
          quantity: p.qty, unitPrice: p.unitPrice,
          lineSubtotal: totals.lines[idx]!.lineSubtotal, lineDiscount: totals.lines[idx]!.lineDiscount,
          lineTax: 0, lineTotal: totals.lines[idx]!.lineTotal,
        })),
      );

      // Record promotion usage + bump the global counter (idempotent on order).
      if (promoId) {
        await tx.insert(s.promotionUsage).values({ storeId: st.id, promotionId: promoId, customerId, orderId });
        await tx.update(s.promotion).set({ usedCount: sql`${s.promotion.usedCount} + 1` }).where(eq(s.promotion.id, promoId));
      }
      return { code, grandTotal: totals.grandTotal, discountTotal: totals.discountTotal, couponApplied: promoId != null };
    }).catch(async (e: unknown): Promise<Result> => {
      // Concurrent double-submit with the same Idempotency-Key: the unique
      // (store, key) index rejected the loser; its txn (incl. allocation) rolled
      // back. Return the winner's order in a fresh read.
      if (idemKey && (e as { code?: string })?.code === '23505') {
        return withStore(st.id, async (tx): Promise<Result> => {
          const [o] = await tx
            .select({ code: s.order.code, grandTotal: s.order.grandTotal, discountTotal: s.order.discountTotal })
            .from(s.order)
            .where(eq(s.order.idempotencyKey, idemKey))
            .limit(1);
          if (o) return { code: o.code, grandTotal: o.grandTotal, discountTotal: o.discountTotal, couponApplied: o.discountTotal > 0, replay: true };
          throw e;
        });
      }
      throw e;
    });

    if ('blocked' in out) return c.json({ error: 'unavailable or out of stock', skus: out.blocked }, 409);
    return c.json({ code: out.code, state: 'PendingPayment', grandTotal: out.grandTotal, discountTotal: out.discountTotal, currency: st.currency, couponApplied: out.couponApplied }, 200);
  },
);
