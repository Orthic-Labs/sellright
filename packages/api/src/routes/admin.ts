import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { bearer } from '../auth/session.js';
import { verifyPassword } from '../auth/password.js';
import { createAdminSession, deleteAdminSession, findAdminByEmail, resolveAdmin } from '../auth/admin-session.js';
import { canTransition, type OrderState } from '../money/fsm.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, guard, money, Page, PAID_STATES } from './admin-helpers.js';
import { clientIp, loginRetryAfter, recordLoginFailure, clearLoginAttempts } from '../auth/rate-limit.js';
import { setAuthCookies, clearAuthCookies, newCsrf, cookie, SESSION_COOKIE } from '../auth/cookies.js';
import { verifyTotp } from '../auth/totp.js';
import { normalizeEmail } from '../auth/email.js';

export const admin = new OpenAPIHono();

const StoreAccess = z.object({ storeId: z.string(), slug: z.string(), name: z.string(), currency: z.string(), role: z.string() });

// ── auth: login / logout / me ─────────────────────────────────────────────
admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/login', summary: 'Admin login',
    request: { body: { content: J(z.object({ email: z.string().email(), password: z.string(), totp: z.string().optional() })) } },
    responses: {
      200: { description: 'OK or 2FA required', content: J(z.object({ token: z.string().optional(), csrfToken: z.string().optional(), twoFactorRequired: z.boolean().optional(), admin: z.object({ email: z.string() }).optional(), stores: z.array(StoreAccess).optional() })) },
      401: { description: 'Invalid', ...errBody },
      429: { description: 'Too many attempts', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { email: rawEmail, password, totp } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    const ip = clientIp(c);
    const retry = loginRetryAfter(ip, `admin:${email}`);
    if (retry > 0) throw new HttpError(429, `too many attempts — try again in ${retry}s`);
    const u = await findAdminByEmail(email);
    if (!u || !(await verifyPassword(password, u.passwordHash))) { recordLoginFailure(ip, `admin:${email}`); throw new HttpError(401, 'invalid email or password'); }
    // Second factor, if enabled.
    if (u.totpSecret) {
      if (!totp) return c.json({ twoFactorRequired: true }, 200); // prompt for the code
      if (!verifyTotp(u.totpSecret, totp)) { recordLoginFailure(ip, `admin:${email}`); throw new HttpError(401, 'invalid 2FA code'); }
    }
    clearLoginAttempts(ip, `admin:${email}`);
    const token = await createAdminSession(u.id);
    const csrf = newCsrf();
    setAuthCookies(c, token, csrf); // httpOnly session cookie + CSRF cookie
    const admin = await resolveAdmin(token);
    return c.json({ token, csrfToken: csrf, admin: { email: u.email }, stores: admin?.stores ?? [] }, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/logout', summary: 'Admin logout',
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) } },
  }),
  async (c) => {
    const token = bearer(c.req.header('authorization')) ?? cookie(c, SESSION_COOKIE);
    if (token) await deleteAdminSession(token);
    clearAuthCookies(c);
    return c.json({ ok: true }, 200);
  },
);

admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/me', summary: 'Current admin + accessible stores',
    responses: {
      200: { description: 'OK', content: J(z.object({ email: z.string(), stores: z.array(StoreAccess) })) },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    return c.json({ email: admin.email, stores: admin.stores }, 200);
  }),
);

// ── dashboard KPIs ─────────────────────────────────────────────────────────
admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/dashboard', summary: 'Store dashboard KPIs',
    responses: {
      200: { description: 'OK', content: J(z.object({
        store: z.object({ slug: z.string(), name: z.string(), currency: z.string() }),
        revenue: money, orders: z.number().int(), aov: money,
        pendingFulfillment: z.number().int(), customers: z.number().int(), lowStock: z.number().int(),
        recentOrders: z.array(z.any()),
      })) },
      401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const out = await withStore(st.storeId, async (tx) => {
      const [agg] = await tx
        .select({ revenue: sql<number>`coalesce(sum(${s.order.grandTotal}),0)::int`, cnt: sql<number>`count(*)::int` })
        .from(s.order)
        .where(sql`${s.order.state} = any(${PAID_STATES})`);
      const revenue = agg?.revenue ?? 0;
      const cnt = agg?.cnt ?? 0;
      // To-fulfill = Paid orders with no Shipped/Delivered fulfillment record yet.
      // (order.state stays 'Paid' after shipping — shipping state lives on the
      // fulfillment record, so a bare state='Paid' count over-reports.)
      const [pf] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.order)
        .where(sql`${s.order.state} = 'Paid' and not exists (select 1 from fulfillment f where f.order_id = ${s.order.id} and f.state in ('Shipped','Delivered'))`);
      const [cu] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.customer);
      const [ls] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.stock)
        .where(sql`${s.stock.onHand} - ${s.stock.allocated} <= 3`);
      const recent = await tx
        .select({ code: s.order.code, state: s.order.state, grandTotal: s.order.grandTotal, currency: s.order.currency, placedAt: s.order.placedAt, email: s.customer.email })
        .from(s.order)
        .leftJoin(s.customer, eq(s.customer.id, s.order.customerId))
        .orderBy(desc(sql`coalesce(${s.order.placedAt}, ${s.order.createdAt})`))
        .limit(8);
      return {
        revenue, orders: cnt, aov: cnt ? Math.round(revenue / cnt) : 0,
        pendingFulfillment: pf?.n ?? 0, customers: cu?.n ?? 0, lowStock: ls?.n ?? 0,
        recentOrders: recent.map((r) => ({ ...r, placedAt: r.placedAt ? r.placedAt.toISOString() : null })),
      };
    });
    return c.json({ store: { slug: st.slug, name: st.name, currency: st.currency }, ...out }, 200);
  }),
);

// ── orders: list / detail / fulfill / cancel ────────────────────────────────
admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/orders', summary: 'List orders',
    request: { query: z.object({ state: z.string().optional(), q: z.string().optional(), preOrder: z.coerce.boolean().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }) },
    responses: { 200: { description: 'OK', content: J(Page) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { state, q, preOrder, page, pageSize } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const conds = [] as ReturnType<typeof eq>[];
      if (state) conds.push(sql`${s.order.state} = ${state}` as never);
      if (preOrder) conds.push(eq(s.order.isPreOrder, true) as never);
      if (q) conds.push(or(ilike(s.order.code, `%${q}%`), ilike(s.customer.email, `%${q}%`)) as never);
      const where = conds.length ? and(...conds) : undefined;
      const base = tx
        .select({ code: s.order.code, state: s.order.state, isPreOrder: s.order.isPreOrder, grandTotal: s.order.grandTotal, currency: s.order.currency, placedAt: s.order.placedAt, createdAt: s.order.createdAt, email: s.customer.email })
        .from(s.order)
        .leftJoin(s.customer, eq(s.customer.id, s.order.customerId))
        .$dynamic();
      const rows = await (where ? base.where(where) : base)
        .orderBy(desc(sql`coalesce(${s.order.placedAt}, ${s.order.createdAt})`))
        .limit(pageSize).offset((page - 1) * pageSize);
      const cntBase = tx.select({ n: sql<number>`count(*)::int` }).from(s.order).leftJoin(s.customer, eq(s.customer.id, s.order.customerId)).$dynamic();
      const [cnt] = await (where ? cntBase.where(where) : cntBase);
      return {
        items: rows.map((r) => ({ ...r, placedAt: r.placedAt ? r.placedAt.toISOString() : null, createdAt: r.createdAt.toISOString() })),
        total: cnt?.n ?? 0, page, pageSize,
      };
    });
    return c.json(out, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/orders/{code}', summary: 'Order detail',
    request: { params: z.object({ code: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { code } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return null;
      const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      const payments = await tx.select().from(s.payment).where(eq(s.payment.orderId, o.id)).orderBy(desc(s.payment.createdAt));
      const fulfillments = await tx.select().from(s.fulfillment).where(eq(s.fulfillment.orderId, o.id)).orderBy(desc(s.fulfillment.createdAt));
      const events = await tx.select().from(s.auditLog).where(and(eq(s.auditLog.entity, 'order'), eq(s.auditLog.entityId, o.id))).orderBy(desc(s.auditLog.at)).limit(50);
      let customer = null as null | { id: string; email: string; firstName: string | null; lastName: string | null; phone: string | null };
      if (o.customerId) {
        const [cu] = await tx.select({ id: s.customer.id, email: s.customer.email, firstName: s.customer.firstName, lastName: s.customer.lastName, phone: s.customer.phone }).from(s.customer).where(eq(s.customer.id, o.customerId)).limit(1);
        customer = cu ?? null;
      }
      return {
        code: o.code, state: o.state, isPreOrder: o.isPreOrder, currency: o.currency,
        subtotal: o.subtotal, discountTotal: o.discountTotal, shippingTotal: o.shippingTotal, taxTotal: o.taxTotal, grandTotal: o.grandTotal,
        placedAt: o.placedAt ? o.placedAt.toISOString() : null, createdAt: o.createdAt.toISOString(),
        shippingAddress: o.shippingAddress ?? null, billingAddress: o.billingAddress ?? null,
        customer,
        lines: lines.map((l) => ({ sku: l.variantSku, name: l.variantName, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, fulfilledQty: l.fulfilledQty, refundedQty: l.refundedQty })),
        payments: payments.map((p) => ({ method: p.method, amount: p.amount, state: p.state, providerRef: p.providerRef, createdAt: p.createdAt.toISOString() })),
        fulfillments: fulfillments.map((f) => ({ id: f.id, state: f.state, trackingCode: f.trackingCode, carrier: f.carrier, createdAt: f.createdAt.toISOString() })),
        events: events.map((e) => ({ action: e.action, fromState: e.fromState, toState: e.toState, actor: e.actor, at: e.at.toISOString() })),
      };
    });
    if (!out) throw new HttpError(404, 'order not found');
    return c.json(out, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/fulfill', summary: 'Fulfill order (Shipped/Delivered)',
    request: { params: z.object({ code: z.string() }), body: { content: J(z.object({ state: z.enum(['Shipped', 'Delivered']).default('Shipped'), trackingCode: z.string().optional(), carrier: z.string().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ code: z.string(), fulfillment: z.string() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Conflict', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { code } = c.req.valid('param');
    const { state, trackingCode, carrier } = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return { kind: 'notfound' as const };
      if (o.state !== 'Paid' && o.state !== 'PartiallyRefunded') return { kind: 'badstate' as const, state: o.state };
      const [existing] = await tx.select().from(s.fulfillment).where(eq(s.fulfillment.orderId, o.id)).orderBy(desc(s.fulfillment.createdAt)).limit(1);
      // Fulfillment state only advances: Pending -> Shipped -> Delivered. Block
      // a backward move (e.g. re-shipping an already-Delivered order).
      if (existing && existing.state === 'Delivered' && state === 'Shipped') return { kind: 'regress' as const, state: existing.state };
      const advancingToShipped = state === 'Shipped' && (!existing || existing.state === 'Pending');
      let fid: string;
      if (existing) {
        await tx.update(s.fulfillment).set({ state, trackingCode: trackingCode ?? existing.trackingCode, carrier: carrier ?? existing.carrier, updatedAt: new Date() }).where(eq(s.fulfillment.id, existing.id));
        fid = existing.id;
      } else {
        const [f] = await tx.insert(s.fulfillment).values({ storeId: st.storeId, orderId: o.id, state, trackingCode: trackingCode ?? null, carrier: carrier ?? null }).returning({ id: s.fulfillment.id });
        fid = f!.id;
      }
      // On the transition INTO Shipped (not on a repeat call), ship every line in
      // full (all-or-nothing fulfillment — partial qty is a v2 feature). Shipping
      // consumes reserved stock: decrement on_hand AND release allocated for the
      // shipped units, and record the movement.
      if (advancingToShipped) {
        const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
        for (const l of lines) {
          const ship = l.quantity - l.fulfilledQty;
          if (ship <= 0) continue;
          await tx.update(s.orderLine).set({ fulfilledQty: l.quantity }).where(eq(s.orderLine.id, l.id));
          if (l.variantId) {
            await tx.update(s.stock).set({
              onHand: sql`greatest(${s.stock.onHand} - ${ship}, 0)`,
              allocated: sql`greatest(${s.stock.allocated} - ${ship}, 0)`,
            }).where(eq(s.stock.variantId, l.variantId));
            await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: l.variantId, delta: -ship, reason: 'fulfillment', refOrderId: o.id });
          }
        }
      }
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'fulfill', toState: state });
      return { kind: 'ok' as const, fid, state };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'badstate') throw new HttpError(409, `order not fulfillable in state ${res.state}`);
    if (res.kind === 'regress') throw new HttpError(409, `cannot move fulfillment from ${res.state} back to Shipped`);
    return c.json({ code, fulfillment: res.state }, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/cancel', summary: 'Cancel order',
    request: { params: z.object({ code: z.string() }), body: { content: J(z.object({ reason: z.string().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ code: z.string(), state: z.string() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Conflict', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { code } = c.req.valid('param');
    const res = await withStore(st.storeId, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return { kind: 'notfound' as const };
      if (!canTransition(o.state as OrderState, 'Cancelled')) return { kind: 'badstate' as const, state: o.state };
      // Release stock still reserved for unshipped units. Shipped units already
      // had their allocation released (see fulfill), so release = unfulfilled qty.
      const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      for (const l of lines) {
        const release = l.quantity - l.fulfilledQty;
        if (release > 0 && l.variantId) {
          await tx.update(s.stock).set({ allocated: sql`greatest(${s.stock.allocated} - ${release}, 0)` })
            .where(and(eq(s.stock.variantId, l.variantId), eq(s.stock.storeId, st.storeId)));
        }
      }
      await tx.update(s.order).set({ state: 'Cancelled', updatedAt: new Date() }).where(eq(s.order.id, o.id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'cancel', fromState: o.state, toState: 'Cancelled' });
      return { kind: 'ok' as const };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'badstate') throw new HttpError(409, `cannot cancel order in state ${res.state}`);
    return c.json({ code, state: 'Cancelled' }, 200);
  }),
);

// ── products: list / detail / edit; variants: price / stock ─────────────────
admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/products', summary: 'List products',
    request: { query: z.object({ q: z.string().optional(), status: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }) },
    responses: { 200: { description: 'OK', content: J(Page) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { q, status, page, pageSize } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const conds = [sql`${s.product.deletedAt} is null`] as never[];
      if (q) conds.push(ilike(s.product.name, `%${q}%`) as never);
      if (status) conds.push(sql`${s.product.status} = ${status}` as never);
      const where = and(...conds);
      const rows = await tx
        .select({
          id: s.product.id, slug: s.product.slug, name: s.product.name, status: s.product.status,
          assetPath: s.asset.path,
          variants: sql<number>`(select count(*) from product_variant pv where pv.product_id = ${s.product.id} and pv.deleted_at is null)::int`,
          minPrice: sql<number | null>`(select min(coalesce(pv.sale_price, pv.price)) from product_variant pv where pv.product_id = ${s.product.id} and pv.deleted_at is null)::int`,
          stock: sql<number>`coalesce((select sum(st.on_hand - st.allocated) from product_variant pv join stock st on st.variant_id = pv.id where pv.product_id = ${s.product.id} and pv.deleted_at is null),0)::int`,
        })
        .from(s.product)
        .leftJoin(s.asset, eq(s.asset.id, s.product.featuredAssetId))
        .where(where)
        .orderBy(s.product.name)
        .limit(pageSize).offset((page - 1) * pageSize);
      const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.product).where(where);
      return { items: rows, total: cnt?.n ?? 0, page, pageSize };
    });
    return c.json(out, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/products/{id}', summary: 'Product detail',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => {
      const [p] = await tx.select().from(s.product).where(eq(s.product.id, id)).limit(1);
      if (!p) return null;
      let assetPath: string | null = null;
      if (p.featuredAssetId) {
        const [a] = await tx.select({ path: s.asset.path }).from(s.asset).where(eq(s.asset.id, p.featuredAssetId)).limit(1);
        assetPath = a?.path ?? null;
      }
      const variants = await tx
        .select({ id: s.productVariant.id, sku: s.productVariant.sku, name: s.productVariant.name, price: s.productVariant.price, salePrice: s.productVariant.salePrice, enabled: s.productVariant.enabled, onHand: s.stock.onHand, allocated: s.stock.allocated })
        .from(s.productVariant)
        .leftJoin(s.stock, eq(s.stock.variantId, s.productVariant.id))
        .where(and(eq(s.productVariant.productId, id), sql`${s.productVariant.deletedAt} is null`))
        .orderBy(s.productVariant.name);
      return {
        id: p.id, slug: p.slug, name: p.name, description: p.description, status: p.status, assetPath,
        variants: variants.map((v) => ({ ...v, onHand: v.onHand ?? 0, allocated: v.allocated ?? 0, available: (v.onHand ?? 0) - (v.allocated ?? 0) })),
      };
    });
    if (!out) throw new HttpError(404, 'product not found');
    return c.json(out, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/products/{id}', summary: 'Update product',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ name: z.string().optional(), description: z.string().nullable().optional(), status: z.enum(['draft', 'active']).optional(), vendor: z.string().nullable().optional(), productType: z.string().nullable().optional(), tags: z.array(z.string()).nullable().optional(), seoTitle: z.string().nullable().optional(), seoDescription: z.string().nullable().optional(), metafields: z.record(z.string(), z.any()).nullable().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [p] = await tx.select({ id: s.product.id, status: s.product.status }).from(s.product).where(eq(s.product.id, id)).limit(1);
      if (!p) return false;
      await tx.update(s.product).set({ ...patch, updatedAt: new Date() }).where(eq(s.product.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'product', entityId: id, action: 'update', fromState: p.status, toState: patch.status ?? p.status, data: patch });
      return true;
    });
    if (!ok) throw new HttpError(404, 'product not found');
    return c.json({ id }, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/variants/{id}', summary: 'Update variant price/availability',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ price: money.optional(), salePrice: money.nullable().optional(), compareAtPrice: money.nullable().optional(), cost: money.nullable().optional(), barcode: z.string().nullable().optional(), weightG: z.number().int().nullable().optional(), dimensions: z.record(z.string(), z.any()).nullable().optional(), metafields: z.record(z.string(), z.any()).nullable().optional(), enabled: z.boolean().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [v] = await tx.select({ id: s.productVariant.id }).from(s.productVariant).where(eq(s.productVariant.id, id)).limit(1);
      if (!v) return false;
      await tx.update(s.productVariant).set({ ...patch, updatedAt: new Date() }).where(eq(s.productVariant.id, id));
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'update', data: patch });
      return true;
    });
    if (!ok) throw new HttpError(404, 'variant not found');
    return c.json({ id }, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/variants/{id}/stock', summary: 'Set variant on-hand stock',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ onHand: z.number().int().min(0) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), onHand: z.number().int() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { id } = c.req.valid('param');
    const { onHand } = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [cur] = await tx.select().from(s.stock).where(eq(s.stock.variantId, id)).limit(1);
      if (cur) {
        const delta = onHand - cur.onHand;
        await tx.update(s.stock).set({ onHand }).where(eq(s.stock.variantId, id));
        if (delta !== 0) await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta, reason: 'admin_adjust' });
      } else {
        const [v] = await tx.select({ id: s.productVariant.id }).from(s.productVariant).where(eq(s.productVariant.id, id)).limit(1);
        if (!v) return false;
        await tx.insert(s.stock).values({ variantId: id, storeId: st.storeId, onHand, allocated: 0 });
        await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: id, delta: onHand, reason: 'admin_adjust' });
      }
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'variant', entityId: id, action: 'stock', data: { onHand } });
      return true;
    });
    if (!ok) throw new HttpError(404, 'variant not found');
    return c.json({ id, onHand }, 200);
  }),
);

// ── customers: list / detail ─────────────────────────────────────────────────
admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/customers', summary: 'List customers',
    request: { query: z.object({ q: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }) },
    responses: { 200: { description: 'OK', content: J(Page) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { q, page, pageSize } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const conds = [sql`${s.customer.deletedAt} is null`] as never[];
      if (q) conds.push(or(ilike(s.customer.email, `%${q}%`), ilike(s.customer.firstName, `%${q}%`), ilike(s.customer.lastName, `%${q}%`)) as never);
      const where = and(...conds);
      const rows = await tx
        .select({
          id: s.customer.id, email: s.customer.email, firstName: s.customer.firstName, lastName: s.customer.lastName, createdAt: s.customer.createdAt,
          orders: sql<number>`(select count(*) from "order" o where o.customer_id = ${s.customer.id} and o.state = any(${PAID_STATES}))::int`,
          spent: sql<number>`coalesce((select sum(o.grand_total) from "order" o where o.customer_id = ${s.customer.id} and o.state = any(${PAID_STATES})),0)::int`,
        })
        .from(s.customer)
        .where(where)
        .orderBy(desc(s.customer.createdAt))
        .limit(pageSize).offset((page - 1) * pageSize);
      const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.customer).where(where);
      return { items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), total: cnt?.n ?? 0, page, pageSize };
    });
    return c.json(out, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/customers/{id}', summary: 'Customer detail',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => {
      const [cu] = await tx.select().from(s.customer).where(eq(s.customer.id, id)).limit(1);
      if (!cu) return null;
      const addresses = await tx.select().from(s.address).where(eq(s.address.customerId, id));
      // Lifetime stats from the FULL order set (not the 50-row display window).
      const [stats] = await tx
        .select({
          orderCount: sql<number>`count(*) filter (where ${s.order.state} = any(${PAID_STATES}))::int`,
          spent: sql<number>`coalesce(sum(${s.order.grandTotal}) filter (where ${s.order.state} = any(${PAID_STATES})),0)::int`,
        })
        .from(s.order)
        .where(eq(s.order.customerId, id));
      const orders = await tx.select({ code: s.order.code, state: s.order.state, grandTotal: s.order.grandTotal, currency: s.order.currency, placedAt: s.order.placedAt, createdAt: s.order.createdAt }).from(s.order).where(eq(s.order.customerId, id)).orderBy(desc(s.order.createdAt)).limit(50);
      return {
        id: cu.id, email: cu.email, firstName: cu.firstName, lastName: cu.lastName, phone: cu.phone, emailVerified: cu.emailVerified, createdAt: cu.createdAt.toISOString(),
        orderCount: stats?.orderCount ?? 0, spent: stats?.spent ?? 0,
        addresses: addresses.map((a) => ({ fullName: a.fullName, line1: a.line1, line2: a.line2, city: a.city, province: a.province, postalCode: a.postalCode, country: a.country, phone: a.phone })),
        orders: orders.map((o) => ({ ...o, placedAt: o.placedAt ? o.placedAt.toISOString() : null, createdAt: o.createdAt.toISOString() })),
      };
    });
    if (!out) throw new HttpError(404, 'customer not found');
    return c.json(out, 200);
  }),
);
