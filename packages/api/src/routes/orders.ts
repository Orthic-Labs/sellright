import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';

async function store(c: { req: { header: (k: string) => string | undefined } }): Promise<StoreCtx> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  return resolveStore(slug);
}

export const orders = new OpenAPIHono();

// GET /v1/shop/orders/{code} — order summary by code (confirmation page).
orders.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/orders/{code}',
    summary: 'Order summary by code',
    request: { params: z.object({ code: z.string() }) },
    responses: {
      200: {
        description: 'Order',
        content: {
          'application/json': {
            schema: z.object({
              code: z.string(), state: z.string(), currency: z.string(),
              subtotal: z.number().int(), shippingTotal: z.number().int(), taxTotal: z.number().int(),
              discountTotal: z.number().int(), grandTotal: z.number().int(),
              placedAt: z.string().nullable(),
              shippingAddress: z.any(),
              lines: z.array(z.object({ sku: z.string(), name: z.string(), quantity: z.number().int(), unitPrice: z.number().int(), lineTotal: z.number().int() })),
            }),
          },
        },
      },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { code } = c.req.valid('param');
    const out = await withStore(st.id, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return null;
      const lines = await tx
        .select({ sku: s.orderLine.variantSku, name: s.orderLine.variantName, quantity: s.orderLine.quantity, unitPrice: s.orderLine.unitPrice, lineTotal: s.orderLine.lineTotal })
        .from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      return {
        code: o.code, state: o.state, currency: o.currency,
        subtotal: o.subtotal, shippingTotal: o.shippingTotal, taxTotal: o.taxTotal, discountTotal: o.discountTotal, grandTotal: o.grandTotal,
        placedAt: o.placedAt ? o.placedAt.toISOString() : null,
        shippingAddress: o.shippingAddress ?? null, lines,
      };
    });
    if (!out) return c.json({ error: 'order not found' }, 404);
    return c.json(out, 200);
  },
);
