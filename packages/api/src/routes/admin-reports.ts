import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, guard, PAID_STATES } from './admin-helpers.js';
import { normalizeEmail } from '../auth/email.js';

export const adminReports = new OpenAPIHono();

// ── customer create / edit ───────────────────────────────────────────────────
adminReports.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/customers', summary: 'Create a customer',
    request: { body: { content: J(z.object({ email: z.string().email(), firstName: z.string().optional(), lastName: z.string().optional(), phone: z.string().optional(), tags: z.array(z.string()).optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 409: { description: 'Email exists', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const b = c.req.valid('json');
    const email = normalizeEmail(b.email);
    const res = await withStore(st.storeId, async (tx) => {
      const [dupe] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, email)).limit(1);
      if (dupe) return { dupe: true as const };
      const [cu] = await tx.insert(s.customer).values({ storeId: st.storeId, email, firstName: b.firstName ?? null, lastName: b.lastName ?? null, phone: b.phone ?? null, tags: b.tags ?? null }).returning({ id: s.customer.id });
      return { id: cu!.id };
    });
    if ('dupe' in res) throw new HttpError(409, 'a customer with that email already exists');
    return c.json({ id: res.id }, 200);
  }),
);

adminReports.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/customers/{id}', summary: 'Update a customer',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ firstName: z.string().nullable().optional(), lastName: z.string().nullable().optional(), phone: z.string().nullable().optional(), tags: z.array(z.string()).nullable().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const ok = await withStore(st.storeId, async (tx) => {
      const [cu] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.id, id)).limit(1);
      if (!cu) return false;
      await tx.update(s.customer).set({ ...b, updatedAt: new Date() }).where(eq(s.customer.id, id));
      return true;
    });
    if (!ok) throw new HttpError(404, 'customer not found');
    return c.json({ id }, 200);
  }),
);

// ── reports ──────────────────────────────────────────────────────────────────
const daysQuery = { query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) };

adminReports.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/reports/sales', summary: 'Sales over time',
    request: daysQuery,
    responses: { 200: { description: 'OK', content: J(z.object({ totalRevenue: z.number().int(), totalOrders: z.number().int(), series: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { days } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const series = await tx.execute(sql`
        select to_char(date_trunc('day', coalesce(placed_at, created_at)), 'YYYY-MM-DD') as day,
               count(*)::int as orders, coalesce(sum(grand_total),0)::int as revenue
        from "order"
        where state = any(${PAID_STATES}) and coalesce(placed_at, created_at) >= now() - (${days} || ' days')::interval
        group by 1 order by 1`);
      const rows = (series as unknown as { rows: Array<{ day: string; orders: number; revenue: number }> }).rows;
      return { series: rows, totalRevenue: rows.reduce((a, r) => a + Number(r.revenue), 0), totalOrders: rows.reduce((a, r) => a + Number(r.orders), 0) };
    });
    return c.json(out, 200);
  }),
);

adminReports.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/reports/top-products', summary: 'Top products by revenue',
    request: daysQuery,
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { days } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const r = await tx.execute(sql`
        select ol.variant_name as name, ol.variant_sku as sku, sum(ol.quantity)::int as qty, sum(ol.line_total)::int as revenue
        from order_line ol join "order" o on o.id = ol.order_id
        where o.state = any(${PAID_STATES}) and coalesce(o.placed_at, o.created_at) >= now() - (${days} || ' days')::interval
        group by 1,2 order by revenue desc limit 15`);
      return { items: (r as unknown as { rows: unknown[] }).rows };
    });
    return c.json(out, 200);
  }),
);

adminReports.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/reports/top-customers', summary: 'Top customers by spend',
    request: daysQuery,
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { days } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const r = await tx.execute(sql`
        select cu.id, cu.email, sum(o.grand_total)::int as spent, count(*)::int as orders
        from "order" o join customer cu on cu.id = o.customer_id
        where o.state = any(${PAID_STATES}) and coalesce(o.placed_at, o.created_at) >= now() - (${days} || ' days')::interval
        group by 1,2 order by spent desc limit 15`);
      return { items: (r as unknown as { rows: unknown[] }).rows };
    });
    return c.json(out, 200);
  }),
);

// ── global search ────────────────────────────────────────────────────────────
adminReports.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/search', summary: 'Global search (orders, products, customers)',
    request: { query: z.object({ q: z.string().min(1) }) },
    responses: { 200: { description: 'OK', content: J(z.object({ orders: z.array(z.any()), products: z.array(z.any()), customers: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { q } = c.req.valid('query');
    const like = `%${q}%`;
    const out = await withStore(st.storeId, async (tx) => {
      const orders = await tx.select({ code: s.order.code, state: s.order.state, email: s.customer.email })
        .from(s.order).leftJoin(s.customer, eq(s.customer.id, s.order.customerId))
        .where(or(ilike(s.order.code, like), ilike(s.customer.email, like))).limit(6);
      const products = await tx.select({ id: s.product.id, name: s.product.name, status: s.product.status })
        .from(s.product).where(and(ilike(s.product.name, like), isNull(s.product.deletedAt))).limit(6);
      const customers = await tx.select({ id: s.customer.id, email: s.customer.email, firstName: s.customer.firstName, lastName: s.customer.lastName })
        .from(s.customer).where(or(ilike(s.customer.email, like), ilike(s.customer.firstName, like), ilike(s.customer.lastName, like))).limit(6);
      return { orders, products, customers };
    });
    return c.json(out, 200);
  }),
);

// ── activity log ─────────────────────────────────────────────────────────────
adminReports.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/activity', summary: 'Recent admin activity (audit log)',
    request: { query: z.object({ entity: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) },
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.any()) })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { entity, limit } = c.req.valid('query');
    const items = await withStore(st.storeId, async (tx) => {
      const base = tx.select({ actor: s.auditLog.actor, entity: s.auditLog.entity, entityId: s.auditLog.entityId, action: s.auditLog.action, fromState: s.auditLog.fromState, toState: s.auditLog.toState, at: s.auditLog.at }).from(s.auditLog).$dynamic();
      const rows = await (entity ? base.where(eq(s.auditLog.entity, entity)) : base).orderBy(desc(s.auditLog.at)).limit(limit);
      return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
    });
    return c.json({ items }, 200);
  }),
);

// ── CSV exports + advanced metrics (P3) ───────────────────────────────────────
const cell = (v: unknown) => { const x = v == null ? '' : String(v); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
const csv = (header: string[], rows: unknown[][]) => [header.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n');

adminReports.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/export/products.csv', summary: 'Export products as CSV',
    responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: z.string() } } }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const out = await withStore(st.storeId, async (tx) =>
      tx.select({ slug: s.product.slug, name: s.product.name, status: s.product.status, sku: s.productVariant.sku, price: s.productVariant.price, salePrice: s.productVariant.salePrice, barcode: s.productVariant.barcode })
        .from(s.product).leftJoin(s.productVariant, and(eq(s.productVariant.productId, s.product.id), isNull(s.productVariant.deletedAt)))
        .where(isNull(s.product.deletedAt)).orderBy(s.product.name));
    const body = csv(['slug', 'name', 'status', 'sku', 'price', 'salePrice', 'barcode'], out.map((r) => [r.slug, r.name, r.status, r.sku, r.price, r.salePrice, r.barcode]));
    return c.body(body, 200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="products.csv"' });
  }),
);

adminReports.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/export/customers.csv', summary: 'Export customers as CSV',
    responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: z.string() } } }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const out = await withStore(st.storeId, async (tx) =>
      tx.select({ email: s.customer.email, firstName: s.customer.firstName, lastName: s.customer.lastName, phone: s.customer.phone, emailVerified: s.customer.emailVerified, createdAt: s.customer.createdAt })
        .from(s.customer).where(isNull(s.customer.deletedAt)).orderBy(desc(s.customer.createdAt)));
    const body = csv(['email', 'firstName', 'lastName', 'phone', 'emailVerified', 'createdAt'], out.map((r) => [r.email, r.firstName, r.lastName, r.phone, r.emailVerified, r.createdAt.toISOString()]));
    return c.body(body, 200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="customers.csv"' });
  }),
);

adminReports.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/reports/metrics', summary: 'Advanced metrics (AOV, repeat rate, new vs returning)',
    request: daysQuery,
    responses: { 200: { description: 'OK', content: J(z.object({ aov: z.number().int(), orders: z.number().int(), revenue: z.number().int(), repeatRate: z.number(), newCustomers: z.number().int(), returningCustomers: z.number().int() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { days } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const r = await tx.execute(sql`
        with paid as (
          select id, customer_id, grand_total from "order"
          where state = any(${PAID_STATES}) and coalesce(placed_at, created_at) >= now() - (${days} || ' days')::interval
        ),
        per_cust as (select customer_id, count(*) as n from paid where customer_id is not null group by 1)
        select
          (select coalesce(sum(grand_total),0) from paid)::int as revenue,
          (select count(*) from paid)::int as orders,
          (select count(*) from per_cust)::int as customers,
          (select count(*) from per_cust where n > 1)::int as repeat_customers`);
      const row = (r as unknown as { rows: Array<{ revenue: number; orders: number; customers: number; repeat_customers: number }> }).rows[0]!;
      const aov = row.orders > 0 ? Math.round(row.revenue / row.orders) : 0;
      const repeatRate = row.customers > 0 ? Number((row.repeat_customers / row.customers).toFixed(4)) : 0;
      return { aov, orders: row.orders, revenue: row.revenue, repeatRate, newCustomers: row.customers - row.repeat_customers, returningCustomers: row.repeat_customers };
    });
    return c.json(out, 200);
  }),
);
