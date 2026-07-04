import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import * as s from '../db/schema.js';
import { customerToken, resolveCustomer, type SessionCustomer } from '../auth/session.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { customerCsrfValid, clearCustomerCookies } from '../auth/cookies.js';
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
    const st = await resolveStoreFromCtx(c);
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
    const st = await resolveStoreFromCtx(c);
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
    const st = await resolveStoreFromCtx(c);
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
    const st = await resolveStoreFromCtx(c);
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
    const st = await resolveStoreFromCtx(c);
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
    const st = await resolveStoreFromCtx(c);
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
    request: { params: z.object({ id: z.guid() }), body: { content: { 'application/json': { schema: Address.partial() } } } },
    responses: {
      200: { description: 'Updated', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: errSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: errSchema } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
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
    request: { params: z.object({ id: z.guid() }) },
    responses: {
      200: { description: 'Deleted', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: errSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: errSchema } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
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

// GET /v1/shop/account/export — GDPR data portability: the customer's own
// profile, addresses, and an order-history summary as a single JSON export.
// Order line detail is intentionally excluded (the /account/orders/{code}
// route already exposes it); this is a portable snapshot, not a full re-dump
// of every relational table.
account.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/account/export', summary: 'Export my data (GDPR)',
    responses: {
      200: {
        description: 'Export', content: { 'application/json': { schema: z.object({
          exportedAt: z.string(),
          profile: z.object({ id: z.string(), email: z.string(), firstName: z.string().nullable(), lastName: z.string().nullable(), phone: z.string().nullable(), createdAt: z.string().nullable() }),
          addresses: z.array(z.object({ id: z.string(), fullName: z.string().nullable(), line1: z.string(), line2: z.string().nullable(), city: z.string(), province: z.string().nullable(), postalCode: z.string().nullable(), country: z.string(), phone: z.string().nullable(), isDefaultShipping: z.boolean(), isDefaultBilling: z.boolean() })),
          orders: z.array(z.object({ code: z.string(), state: z.string(), grandTotal: z.number().int(), placedAt: z.string().nullable() })),
        }) } },
      },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: errSchema } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const out = await withStore(st.id, async (tx) => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return null;
      const [profile] = await tx.select({
        id: s.customer.id, email: s.customer.email, firstName: s.customer.firstName,
        lastName: s.customer.lastName, phone: s.customer.phone, createdAt: s.customer.createdAt,
      }).from(s.customer).where(eq(s.customer.id, cust.id)).limit(1);
      const addresses = await tx.select({
        id: s.address.id, fullName: s.address.fullName, line1: s.address.line1, line2: s.address.line2,
        city: s.address.city, province: s.address.province, postalCode: s.address.postalCode,
        country: s.address.country, phone: s.address.phone,
        isDefaultShipping: s.address.isDefaultShipping, isDefaultBilling: s.address.isDefaultBilling,
      }).from(s.address).where(eq(s.address.customerId, cust.id));
      const orders = await tx.select({
        code: s.order.code, state: s.order.state, grandTotal: s.order.grandTotal, placedAt: s.order.placedAt,
      }).from(s.order).where(eq(s.order.customerId, cust.id)).orderBy(desc(s.order.createdAt));
      return { profile, addresses, orders };
    });
    if (out === null) return c.json({ error: 'not authenticated' }, 401);
    return c.json({
      exportedAt: new Date().toISOString(),
      profile: { ...out.profile, createdAt: out.profile.createdAt ? out.profile.createdAt.toISOString() : null },
      addresses: out.addresses,
      orders: out.orders.map((o) => ({ ...o, placedAt: o.placedAt ? o.placedAt.toISOString() : null })),
    }, 200);
  },
);

// DELETE /v1/shop/account — GDPR erasure (COMP-2). Hard-deletes the customer
// row and every PII-bearing table that references it; ORDERS are financial
// records so they are ANONYMIZED (customerId + snapshot email/name nulled/
// scrubbed) rather than deleted — order history/accounting must survive an
// erasure request. Refuses (409) if the customer has a non-canceled
// subscription: an active Stripe subscription needs to be cancelled first so
// billing doesn't keep firing against a customer row that no longer exists
// (safer than silently cancelling on the customer's behalf inside a delete
// call — cancellation has its own confirmation UX elsewhere).
account.openapi(
  createRoute({
    method: 'delete', path: '/v1/shop/account', summary: 'Delete my account (GDPR erasure)',
    responses: {
      200: { description: 'Deleted', content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: errSchema } } },
      403: { description: 'CSRF', content: { 'application/json': { schema: errSchema } } },
      409: { description: 'Active subscription must be cancelled first', content: { 'application/json': { schema: errSchema } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    if (!customerCsrfValid(c)) return c.json({ error: 'invalid CSRF token' }, 403);
    const out = await withStore(st.id, async (tx): Promise<'unauth' | 'active_subscription' | 'ok'> => {
      const cust = await me(tx, customerToken(c));
      if (!cust) return 'unauth';

      const activeSub = await tx.select({ id: s.subscription.id })
        .from(s.subscription)
        .where(and(eq(s.subscription.customerId, cust.id), ne(s.subscription.status, 'canceled')))
        .limit(1);
      if (activeSub.length) return 'active_subscription';

      // Anonymize orders FIRST (order rows are kept — financial records — but
      // scrubbed of the PII that links them back to this person).
      await tx.update(s.order)
        .set({
          customerId: null,
          shippingAddress: null,
          billingAddress: null,
          metadata: sql`coalesce(${s.order.metadata}, '{}'::jsonb) || '{"anonymized_at":"' || now()::text || '"}'::jsonb`,
        })
        .where(eq(s.order.customerId, cust.id));

      // Null customer refs that are allowed to be null (kept for reporting/
      // audit shape) before deleting rows that hard-require the FK.
      await tx.update(s.giftCard).set({ customerId: null }).where(eq(s.giftCard.customerId, cust.id));
      await tx.update(s.promotionUsage).set({ customerId: null }).where(eq(s.promotionUsage.customerId, cust.id));
      await tx.update(s.subscription).set({ customerId: null }).where(eq(s.subscription.customerId, cust.id));
      await tx.update(s.license).set({ customerId: null }).where(eq(s.license.customerId, cust.id));

      // Hard-delete PII-bearing / access-granting rows.
      await tx.delete(s.paymentMethod).where(eq(s.paymentMethod.customerId, cust.id));
      await tx.delete(s.customerToken).where(eq(s.customerToken.customerId, cust.id));
      await tx.delete(s.session).where(eq(s.session.customerId, cust.id));
      await tx.update(s.cart).set({ customerId: null }).where(eq(s.cart.customerId, cust.id)); // cart TTL job reaps it
      await tx.delete(s.address).where(eq(s.address.customerId, cust.id));

      await tx.delete(s.customer).where(eq(s.customer.id, cust.id));
      return 'ok';
    });
    if (out === 'unauth') return c.json({ error: 'not authenticated' }, 401);
    if (out === 'active_subscription') return c.json({ error: 'cancel your active subscription before deleting your account' }, 409);
    clearCustomerCookies(c);
    return c.json({ deleted: true }, 200);
  },
);
