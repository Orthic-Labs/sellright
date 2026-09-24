import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import { customerToken, resolveCustomer } from '../auth/session.js';
import * as s from '../db/schema.js';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';

/** Constant-time string compare (avoids leaking the receipt token via timing). */
function tokensMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return cryptoTimingSafeEqual(ba, bb);
}

export const orders = new OpenAPIHono();

// GET /v1/shop/orders/{code} — order summary by code (confirmation page).
// SCOPED (P1 security): an order code is ~enumerable, so the read is granted ONLY
// when a matching receipt token is supplied (?rt=, returned by /checkout and
// carried to the confirmation page + Stripe return_url) OR the authed customer
// owns the order. A bare code with no token and no ownership reads as not-found
// (404, not 403 — no enumeration/PII disclosure).
orders.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/orders/{code}',
    summary: 'Order summary by code (receipt-token or owner scoped)',
    request: { params: z.object({ code: z.string() }), query: z.object({ rt: z.string().optional() }) },
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
              customerEmail: z.string().nullable(),
              lines: z.array(z.object({ sku: z.string(), name: z.string(), quantity: z.number().int(), unitPrice: z.number().int(), lineTotal: z.number().int(), image: z.string().nullable() })),
            }),
          },
        },
      },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { code } = c.req.valid('param');
    const { rt } = c.req.valid('query');
    const token = customerToken(c);
    const out = await withStore(st.id, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return null;
      // Grant: receipt-token match OR authed ownership. Else treat as not-found.
      let granted = tokensMatch(rt, o.receiptToken);
      if (!granted && token && o.customerId) {
        const cust = await resolveCustomer(tx, token);
        granted = !!cust && cust.id === o.customerId;
      }
      if (!granted) return null;
      // Guest checkouts still link an order to a synthetic/matched customer
      // row (see order.customerId) purely to carry the email the confirmation
      // page shows under "Contact" — not an account. Null when genuinely absent.
      let customerEmail: string | null = null;
      if (o.customerId) {
        const [cust] = await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, o.customerId)).limit(1);
        customerEmail = cust?.email ?? null;
      }
      // Order lines snapshot sku/name/price at purchase time (survives the
      // variant later being edited or deleted) but never carried an image —
      // the confirmation page fell back to a bare placeholder icon for every
      // line. variantId is still kept (nullable) purely to resolve imagery;
      // prefer the variant's own photo, else the parent product's.
      const lines = await tx
        .select({
          sku: s.orderLine.variantSku, name: s.orderLine.variantName, quantity: s.orderLine.quantity, unitPrice: s.orderLine.unitPrice, lineTotal: s.orderLine.lineTotal,
          image: sql<string | null>`coalesce(
            (select a.path from ${s.variantAsset} va join ${s.asset} a on a.id = va.asset_id where va.variant_id = ${s.orderLine.variantId} order by va.position asc limit 1),
            (select a.path from ${s.productVariant} pv join ${s.productAsset} pa on pa.product_id = pv.product_id join ${s.asset} a on a.id = pa.asset_id where pv.id = ${s.orderLine.variantId} order by pa.position asc limit 1)
          )`,
        })
        .from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      return {
        code: o.code, state: o.state, currency: o.currency,
        subtotal: o.subtotal, shippingTotal: o.shippingTotal, taxTotal: o.taxTotal, discountTotal: o.discountTotal, grandTotal: o.grandTotal,
        placedAt: o.placedAt ? o.placedAt.toISOString() : null,
        shippingAddress: o.shippingAddress ?? null, customerEmail, lines,
      };
    });
    if (!out) return c.json({ error: 'order not found' }, 404);
    return c.json(out, 200);
  },
);
