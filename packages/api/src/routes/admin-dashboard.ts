import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { J, errBody, money, PAID_STATES, requireAdmin, requireStore, guard } from './admin-helpers.js';
import { isStorePublished } from '../store-publish.js';
import { fulfillmentStatusSql, paymentStatusWithBalanceSql } from '../orders/status-sql.js';
import { orderContactSql } from '../orders/contact.js';

export const adminDashboard = new OpenAPIHono();

// ── dashboard KPIs ─────────────────────────────────────────────────────────
adminDashboard.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/dashboard', summary: 'Store dashboard KPIs',
    responses: {
      200: { description: 'OK', content: J(z.object({
        store: z.object({ slug: z.string(), name: z.string(), currency: z.string(), published: z.boolean() }),
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
      const [storeRow] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
      const published = isStorePublished(storeRow?.config);
      const [agg] = await tx
        .select({ revenue: sql<number>`coalesce(sum(${s.order.grandTotal}),0)::int`, cnt: sql<number>`count(*)::int` })
        .from(s.order)
        .where(sql`${s.order.state} = any(${PAID_STATES}) and ${s.order.deletedAt} is null and not ${s.order.isDemo}`);
      const revenue = agg?.revenue ?? 0;
      const cnt = agg?.cnt ?? 0;
      // Keep this predicate aligned with the Orders page's canonical
      // Unfulfilled view; both use the shared status SQL projections.
      const [pf] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.order)
        .where(sql`${s.order.deletedAt} is null and ${s.order.isDemo} = false and ${s.order.status} in ('open','completed') and ${paymentStatusWithBalanceSql()} = 'paid' and ${fulfillmentStatusSql()} = 'unfulfilled'`);
      const [cu] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.customer);
      const [ls] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.stock)
        .where(sql`${s.stock.onHand} - ${s.stock.allocated} <= 3`);
      const recent = await tx
        .select({ code: s.order.code, state: s.order.state, grandTotal: s.order.grandTotal, currency: s.order.currency, placedAt: s.order.placedAt, email: orderContactSql('customer').email, isDemo: s.order.isDemo })
        .from(s.order)
        .leftJoin(s.customer, eq(s.customer.id, s.order.customerId))
        .where(isNull(s.order.deletedAt))
        .orderBy(desc(sql`coalesce(${s.order.placedAt}, ${s.order.createdAt})`))
        .limit(8);
      return {
        published,
        revenue, orders: cnt, aov: cnt ? Math.round(revenue / cnt) : 0,
        pendingFulfillment: pf?.n ?? 0, customers: cu?.n ?? 0, lowStock: ls?.n ?? 0,
        recentOrders: recent.map((r) => ({ ...r, placedAt: r.placedAt ? r.placedAt.toISOString() : null })),
      };
    });
    const { published, ...rest } = out;
    return c.json({ store: { slug: st.slug, name: st.name, currency: st.currency, published }, ...rest }, 200);
  }),
);

