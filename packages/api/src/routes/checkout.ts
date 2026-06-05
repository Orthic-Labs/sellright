import { randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { calculateOrderTotals } from '../money/totals.js';

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

const orderCode = () => ('SR' + randomUUID().replace(/-/g, '').slice(0, 10)).toUpperCase();

export const checkout = new OpenAPIHono();

// POST /v1/shop/checkout — create an order from a cart (PendingPayment).
// Re-prices server-side, allocates stock atomically (no oversell), persists
// order + snapshotted lines. Payment is a separate step on the returned order.
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
        content: { 'application/json': { schema: z.object({ code: z.string(), state: z.string(), grandTotal: z.number().int(), currency: z.string() }) } },
      },
      409: { description: 'Out of stock / unavailable', content: { 'application/json': { schema: z.object({ error: z.string(), skus: z.array(z.string()) }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const body = c.req.valid('json');
    const idemKey = c.req.header('idempotency-key') || null;
    const skus = [...new Set(body.items.map((i) => i.sku))];

    type Result = { blocked: string[] } | { code: string; grandTotal: number; replay?: boolean };
    const out = await withStore(st.id, async (tx): Promise<Result> => {
      // Idempotency: if this key already created an order, return THAT order
      // (same key -> same response). A unique (store, key) index also guards the
      // concurrent double-submit race below.
      if (idemKey) {
        const [existing] = await tx
          .select({ code: s.order.code, grandTotal: s.order.grandTotal })
          .from(s.order)
          .where(eq(s.order.idempotencyKey, idemKey))
          .limit(1);
        if (existing) return { code: existing.code, grandTotal: existing.grandTotal, replay: true };
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
        if (v.isPreOrder) continue; // pre-orders are not stock-gated
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
      const totals = calculateOrderTotals({
        lines: priced.map((p) => ({ unitPrice: p.unitPrice, quantity: p.qty })),
        shipping: body.shipping, taxRate: st.taxRate,
      });

      const customerId = body.email
        ? (await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, body.email)).limit(1))[0]?.id ?? null
        : null;

      const orderId = randomUUID();
      const code = orderCode();
      await tx.insert(s.order).values({
        id: orderId, storeId: st.id, code, customerId, state: 'PendingPayment', currency: st.currency,
        idempotencyKey: idemKey,
        subtotal: totals.subtotal, discountTotal: totals.discountTotal, shippingTotal: totals.shippingTotal,
        taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
        isPreOrder: priced.some((p) => p.v.isPreOrder),
        shippingAddress: body.shippingAddress ?? null, billingAddress: body.billingAddress ?? null,
      });
      await tx.insert(s.orderLine).values(
        priced.map((p, idx) => ({
          storeId: st.id, orderId, variantId: p.v.id, variantSku: p.v.sku, variantName: p.v.name,
          quantity: p.qty, unitPrice: p.unitPrice,
          lineSubtotal: totals.lines[idx]!.lineSubtotal, lineDiscount: totals.lines[idx]!.lineDiscount,
          lineTax: 0, lineTotal: totals.lines[idx]!.lineTotal,
        })),
      );
      return { code, grandTotal: totals.grandTotal };
    }).catch(async (e: unknown): Promise<Result> => {
      // Concurrent double-submit with the same Idempotency-Key: the unique
      // (store, key) index rejected the loser; its txn (incl. stock allocation)
      // rolled back. Return the winner's order in a fresh read.
      if (idemKey && (e as { code?: string })?.code === '23505') {
        return withStore(st.id, async (tx): Promise<Result> => {
          const [o] = await tx
            .select({ code: s.order.code, grandTotal: s.order.grandTotal })
            .from(s.order)
            .where(eq(s.order.idempotencyKey, idemKey))
            .limit(1);
          if (o) return { code: o.code, grandTotal: o.grandTotal, replay: true };
          throw e;
        });
      }
      throw e;
    });

    if ('blocked' in out) return c.json({ error: 'unavailable or out of stock', skus: out.blocked }, 409);
    return c.json({ code: out.code, state: 'PendingPayment', grandTotal: out.grandTotal, currency: st.currency }, 200);
  },
);
