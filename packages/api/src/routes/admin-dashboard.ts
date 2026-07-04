import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { J, errBody, money, PAID_STATES, requireAdmin, requireStore, guard } from './admin-helpers.js';

export const adminDashboard = new OpenAPIHono();

// ── dashboard KPIs ─────────────────────────────────────────────────────────
adminDashboard.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/dashboard', summary: 'Store dashboard KPIs',
    responses: {
      200: { description: 'OK', content: J(z.object({
        store: z.object({ slug: z.string(), name: z.string(), currency: z.string() }),
        revenue: money, orders: z.number().int(), aov: money,
        pendingFulfillment: z.number().int(), customers: z.number().int(), lowStock: z.number().int(),
        recentOrders: z.array(z.unknown()),
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
        .where(sql`${s.order.state} = any(${PAID_STATES}) and ${s.order.deletedAt} is null`);
      const revenue = agg?.revenue ?? 0;
      const cnt = agg?.cnt ?? 0;
      // To-fulfill = Paid orders with no Shipped/Delivered fulfillment record yet.
      // (order.state stays 'Paid' after shipping — shipping state lives on the
      // fulfillment record, so a bare state='Paid' count over-reports.)
      const [pf] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.order)
        .where(sql`${s.order.state} = 'Paid' and ${s.order.deletedAt} is null and not exists (select 1 from fulfillment f where f.order_id = ${s.order.id} and f.state in ('Shipped','Delivered'))`);
      const [cu] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.customer);
      const [ls] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.stock)
        .where(sql`${s.stock.onHand} - ${s.stock.allocated} <= 3`);
      const recent = await tx
        .select({ code: s.order.code, state: s.order.state, grandTotal: s.order.grandTotal, currency: s.order.currency, placedAt: s.order.placedAt, email: s.customer.email })
        .from(s.order)
        .leftJoin(s.customer, eq(s.customer.id, s.order.customerId))
        .where(isNull(s.order.deletedAt))
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

