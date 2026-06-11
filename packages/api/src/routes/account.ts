import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { customerToken, resolveCustomer, type SessionCustomer } from '../auth/session.js';

async function store(c: { req: { header: (k: string) => string | undefined } }): Promise<StoreCtx> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  return resolveStore(slug);
}

async function me(tx: Tx, token: string | null): Promise<SessionCustomer | null> {
  return token ? resolveCustomer(tx, token) : null;
}

export const account = new OpenAPIHono();

// GET /v1/shop/account/orders
account.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/account/orders', summary: "Current customer's orders",
    responses: {
      200: { description: 'Orders', content: { 'application/json': { schema: z.object({ items: z.array(z.object({ code: z.string(), state: z.string(), grandTotal: z.number().int(), placedAt: z.string().nullable(), lines: z.number().int() })) } ) } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const out = await withStore(st.id, async (tx) => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return null;
      const items = await tx
        .select({
          code: s.order.code, state: s.order.state, grandTotal: s.order.grandTotal, placedAt: s.order.placedAt,
          lines: sql<number>`count(${s.orderLine.id})::int`,
        })
        .from(s.order)
        .leftJoin(s.orderLine, eq(s.orderLine.orderId, s.order.id))
        .where(eq(s.order.customerId, cust.id))
        .groupBy(s.order.id)
        .orderBy(desc(s.order.createdAt))
        .limit(50);
      return items.map((o) => ({ ...o, placedAt: o.placedAt ? o.placedAt.toISOString() : null }));
    });
    if (out === null) return c.json({ error: 'not authenticated' }, 401);
    return c.json({ items: out }, 200);
  },
);

// GET /v1/shop/account/orders/{code}
account.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/account/orders/{code}', summary: 'Order detail (owned)',
    request: { params: z.object({ code: z.string() }) },
    responses: {
      200: { description: 'Order', content: { 'application/json': { schema: z.object({ code: z.string(), state: z.string(), grandTotal: z.number().int(), lines: z.array(z.object({ sku: z.string(), name: z.string(), quantity: z.number().int(), lineTotal: z.number().int() })) }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { code } = c.req.valid('param');
    const out = await withStore(st.id, async (tx) => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return { kind: 'unauth' as const };
      const [order] = await tx.select().from(s.order).where(and(eq(s.order.code, code), eq(s.order.customerId, cust.id))).limit(1);
      if (!order) return { kind: 'notfound' as const };
      const lines = await tx.select({ sku: s.orderLine.variantSku, name: s.orderLine.variantName, quantity: s.orderLine.quantity, lineTotal: s.orderLine.lineTotal }).from(s.orderLine).where(eq(s.orderLine.orderId, order.id));
      return { kind: 'ok' as const, order, lines };
    });
    if (out.kind !== 'ok') return c.json({ error: out.kind === 'unauth' ? 'not authenticated' : 'order not found' }, 404);
    return c.json({ code: out.order.code, state: out.order.state, grandTotal: out.order.grandTotal, lines: out.lines }, 200);
  },
);

// GET /v1/shop/account/addresses
account.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/account/addresses', summary: 'List addresses',
    responses: {
      200: { description: 'Addresses', content: { 'application/json': { schema: z.object({ items: z.array(z.object({ id: z.string(), fullName: z.string().nullable(), line1: z.string().nullable(), city: z.string().nullable(), country: z.string().nullable() })) }) } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const out = await withStore(st.id, async (tx) => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return null;
      return tx.select({ id: s.address.id, fullName: s.address.fullName, line1: s.address.line1, city: s.address.city, country: s.address.country }).from(s.address).where(eq(s.address.customerId, cust.id));
    });
    if (out === null) return c.json({ error: 'not authenticated' }, 401);
    return c.json({ items: out }, 200);
  },
);
