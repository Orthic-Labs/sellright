import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { customerToken, resolveCustomer, type SessionCustomer } from '../auth/session.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createHash } from 'node:crypto';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

const Address = z.object({
  fullName: z.string().max(200).nullable().optional(),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).nullable().optional(),
  city: z.string().min(1).max(120),
  province: z.string().max(120).nullable().optional(),
  postalCode: z.string().max(40).nullable().optional(),
  country: z.string().min(2).max(2),
  phone: z.string().max(40).nullable().optional(),
  isDefaultShipping: z.boolean().optional(),
  isDefaultBilling: z.boolean().optional(),
});
const errSchema = z.object({ error: z.string() });

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
        .where(and(
          eq(s.order.customerId, cust.id),
          // WP9.5: a guest order auto-linked to this account purely by email match
          // stays hidden until the account's email is verified. Registration does
          // NOT gate on verification, so without this an attacker who registers a
          // victim's email would see the victim's past guest orders.
          ...(cust.emailVerified ? [] : [sql`(${s.order.metadata} ->> 'linked_via') IS DISTINCT FROM 'email_match'`]),
        ))
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
      const [order] = await tx.select().from(s.order).where(and(
        eq(s.order.code, code),
        eq(s.order.customerId, cust.id),
        // WP9.5: same email-match suppression as the list — an unverified account
        // cannot open a guest order linked to it purely by email match.
        ...(cust.emailVerified ? [] : [sql`(${s.order.metadata} ->> 'linked_via') IS DISTINCT FROM 'email_match'`]),
      )).limit(1);
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
      200: { description: 'Addresses', content: { 'application/json': { schema: z.object({ items: z.array(z.object({ id: z.string(), fullName: z.string().nullable(), line1: z.string(), line2: z.string().nullable(), city: z.string(), province: z.string().nullable(), postalCode: z.string().nullable(), country: z.string(), phone: z.string().nullable(), isDefaultShipping: z.boolean(), isDefaultBilling: z.boolean() })) }) } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: errSchema } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const out = await withStore(st.id, async (tx) => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return null;
      return tx.select({
        id: s.address.id, fullName: s.address.fullName, line1: s.address.line1, line2: s.address.line2,
        city: s.address.city, province: s.address.province, postalCode: s.address.postalCode,
        country: s.address.country, phone: s.address.phone,
        isDefaultShipping: s.address.isDefaultShipping, isDefaultBilling: s.address.isDefaultBilling,
      }).from(s.address).where(eq(s.address.customerId, cust.id)).orderBy(desc(s.address.isDefaultShipping));
    });
    if (out === null) return c.json({ error: 'not authenticated' }, 401);
    return c.json({ items: out }, 200);
  },
);

// PATCH /v1/shop/account/me — edit profile (firstName/lastName/phone). WP4a.
account.openapi(
  createRoute({
    method: 'patch', path: '/v1/shop/account/me', summary: 'Update profile',
    request: { body: { content: { 'application/json': { schema: z.object({ firstName: z.string().max(120).nullable().optional(), lastName: z.string().max(120).nullable().optional(), phone: z.string().max(40).nullable().optional() }) } } } },
    responses: {
      200: { description: 'Updated', content: { 'application/json': { schema: z.object({ id: z.string(), email: z.string(), firstName: z.string().nullable(), lastName: z.string().nullable(), phone: z.string().nullable() }) } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: errSchema } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const body = c.req.valid('json');
    const out = await withStore(st.id, async (tx) => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return null;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.firstName !== undefined) patch.firstName = body.firstName;
      if (body.lastName !== undefined) patch.lastName = body.lastName;
      if (body.phone !== undefined) patch.phone = body.phone;
      const [row] = await tx.update(s.customer).set(patch).where(eq(s.customer.id, cust.id))
        .returning({ id: s.customer.id, email: s.customer.email, firstName: s.customer.firstName, lastName: s.customer.lastName, phone: s.customer.phone });
      return row ?? null;
    });
    if (out === null) return c.json({ error: 'not authenticated' }, 401);
    return c.json(out, 200);
  },
);

// POST /v1/shop/account/password — change password (verify current first). WP4a.
account.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/account/password', summary: 'Change password',
    request: { body: { content: { 'application/json': { schema: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) }) } } } },
    responses: {
      200: { description: 'Changed', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      401: { description: 'Unauthenticated or wrong current password', content: { 'application/json': { schema: errSchema } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { currentPassword, newPassword } = c.req.valid('json');
    const out = await withStore(st.id, async (tx): Promise<'unauth' | 'wrong' | 'ok'> => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return 'unauth';
      const [row] = await tx.select({ passwordHash: s.customer.passwordHash }).from(s.customer).where(eq(s.customer.id, cust.id)).limit(1);
      if (!(await verifyPassword(currentPassword, row?.passwordHash ?? null))) return 'wrong';
      const hash = await hashPassword(newPassword);
      await tx.update(s.customer).set({ passwordHash: hash, updatedAt: new Date() }).where(eq(s.customer.id, cust.id));
      // Invalidate OTHER sessions for this customer; the current token stays valid.
      const tok = customerToken(c);
      const conds = [eq(s.session.customerId, cust.id)];
      if (tok) conds.push(sql`${s.session.tokenHash} <> ${hashToken(tok)}`);
      await tx.delete(s.session).where(and(...conds));
      return 'ok';
    });
    if (out === 'unauth') return c.json({ error: 'not authenticated' }, 401);
    if (out === 'wrong') return c.json({ error: 'current password is incorrect' }, 401);
    return c.json({ ok: true }, 200);
  },
);

// POST /v1/shop/account/addresses — create. WP4a.
account.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/account/addresses', summary: 'Add address',
    request: { body: { content: { 'application/json': { schema: Address } } } },
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: z.object({ id: z.string() }) } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: errSchema } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const body = c.req.valid('json');
    const out = await withStore(st.id, async (tx) => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return null;
      const [row] = await tx.insert(s.address).values({
        storeId: st.id, customerId: cust.id,
        fullName: body.fullName ?? null, line1: body.line1, line2: body.line2 ?? null,
        city: body.city, province: body.province ?? null, postalCode: body.postalCode ?? null,
        country: body.country.toUpperCase(), phone: body.phone ?? null,
        isDefaultShipping: body.isDefaultShipping ?? false, isDefaultBilling: body.isDefaultBilling ?? false,
      }).returning({ id: s.address.id });
      return row!.id;
    });
    if (out === null) return c.json({ error: 'not authenticated' }, 401);
    return c.json({ id: out }, 201);
  },
);

// PATCH /v1/shop/account/addresses/{id} — update (own only). WP4a.
account.openapi(
  createRoute({
    method: 'patch', path: '/v1/shop/account/addresses/{id}', summary: 'Update address',
    request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: Address.partial() } } } },
    responses: {
      200: { description: 'Updated', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: errSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: errSchema } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const out = await withStore(st.id, async (tx): Promise<'unauth' | 'notfound' | 'ok'> => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return 'unauth';
      const patch: Record<string, unknown> = {};
      for (const k of ['fullName', 'line1', 'line2', 'city', 'province', 'postalCode', 'phone', 'isDefaultShipping', 'isDefaultBilling'] as const) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      if (body.country !== undefined) patch.country = body.country.toUpperCase();
      if (Object.keys(patch).length === 0) return 'ok';
      // Ownership: customerId in the WHERE (RLS already scopes to the store).
      const res = await tx.update(s.address).set(patch).where(and(eq(s.address.id, id), eq(s.address.customerId, cust.id))).returning({ id: s.address.id });
      return res.length ? 'ok' : 'notfound';
    });
    if (out === 'unauth') return c.json({ error: 'not authenticated' }, 401);
    if (out === 'notfound') return c.json({ error: 'address not found' }, 404);
    return c.json({ ok: true }, 200);
  },
);

// DELETE /v1/shop/account/addresses/{id} — delete (own only). WP4a.
account.openapi(
  createRoute({
    method: 'delete', path: '/v1/shop/account/addresses/{id}', summary: 'Delete address',
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: { description: 'Deleted', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: errSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: errSchema } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { id } = c.req.valid('param');
    const out = await withStore(st.id, async (tx): Promise<'unauth' | 'notfound' | 'ok'> => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return 'unauth';
      const res = await tx.delete(s.address).where(and(eq(s.address.id, id), eq(s.address.customerId, cust.id))).returning({ id: s.address.id });
      return res.length ? 'ok' : 'notfound';
    });
    if (out === 'unauth') return c.json({ error: 'not authenticated' }, 401);
    if (out === 'notfound') return c.json({ error: 'address not found' }, 404);
    return c.json({ ok: true }, 200);
  },
);
