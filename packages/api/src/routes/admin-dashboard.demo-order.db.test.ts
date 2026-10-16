/**
 * Demo-order exclusion (plan §1.5): an order placed while a store is
 * unpublished is flagged order.is_demo and must never inflate revenue/order
 * KPIs. Mirrors admin-seo.db.test.ts's seed + app.request() style.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { admin } from './admin.js';
import { adminDashboard } from './admin-dashboard.js';
import { adminOrderOps } from './admin-order-ops.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-dashboard.demo-order.db.test.ts');

const STORE = 'eeeeeeee-0000-0000-0000-00000000da01';
const SLUG = 'demo-order-test-store';
const OWNER = 'eeeeeeee-0000-0000-0000-00000000da02';
const ORDER_REAL = 'eeeeeeee-0000-0000-0000-00000000da03';
const ORDER_DEMO = 'eeeeeeee-0000-0000-0000-00000000da04';
const PRODUCT = 'eeeeeeee-0000-0000-0000-00000000da05';
const VARIANT = 'eeeeeeee-0000-0000-0000-00000000da06';

const app = new OpenAPIHono();
app.route('/', admin);
app.route('/', adminDashboard);
app.route('/', adminOrderOps);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<string> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, 'Demo Order Test Store', 'USD', '{"published": true}'::jsonb)`,
    [STORE, SLUG],
  );
  await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, 'owner@demoorder.test')`, [OWNER]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [OWNER, STORE]);

  // A real, published-store order.
  await pool.query(
    `INSERT INTO "order" (id, store_id, code, state, currency, grand_total, is_demo, placed_at)
     VALUES ($1, $2, 'REAL-1', 'Paid', 'USD', 10000, false, now())`,
    [ORDER_REAL, STORE],
  );
  // A demo order — as checkout.ts would flag one placed while unpublished.
  await pool.query(
    `INSERT INTO "order" (id, store_id, code, state, currency, grand_total, is_demo, placed_at)
     VALUES ($1, $2, 'DEMO-1', 'Paid', 'USD', 99999999, true, now())`,
    [ORDER_DEMO, STORE],
  );

  return createAdminSession(OWNER);
}

async function seedFulfillmentCases(): Promise<string> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, 'To Fulfill Test Store', 'USD')`,
    [STORE, SLUG],
  );
  await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, 'owner@demoorder.test')`, [OWNER]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [OWNER, STORE]);
  await pool.query(`INSERT INTO product (id, store_id, slug, name, status) VALUES ($1, $2, 'p', 'P', 'active')`, [PRODUCT, STORE]);
  await pool.query(`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES ($1, $2, $3, 'SKU-1', 'V1', 1000)`, [VARIANT, STORE, PRODUCT]);

  type Case = { code: string; state?: 'Paid' | 'Cancelled'; demo?: boolean; deleted?: boolean; quantity?: number; fulfilled?: number; cancelled?: number; settled?: number };
  const createOrder = async (c: Case, sort: number) => {
    const quantity = c.quantity ?? 1;
    const total = quantity * 1000;
    const orderId = (await pool.query(
      `INSERT INTO "order" (id, store_id, code, state, currency, subtotal, grand_total, is_demo, deleted_at, placed_at)
       VALUES (gen_random_uuid(), $1, $2, $3::order_state, 'USD', $4, $4, $5,
         CASE WHEN $6 THEN now() ELSE NULL END, now() + ($7 * interval '1 second')) RETURNING id`,
      [STORE, c.code, c.state ?? 'Paid', total, c.demo ?? false, c.deleted ?? false, sort],
    )).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty, cancelled_qty)
       VALUES (gen_random_uuid(), $1, $2, $3, 'SKU-1', 'V1', $4, 1000, $5, $5, $6, $7)`,
      [STORE, orderId, VARIANT, quantity, total, c.fulfilled ?? 0, c.cancelled ?? 0],
    );
    await pool.query(
      `INSERT INTO payment (id, store_id, order_id, amount, method, state)
       VALUES (gen_random_uuid(), $1, $2, $3, 'manual', 'Settled')`,
      [STORE, orderId, c.settled ?? total],
    );
  };

  const eligible = ['TO-FULFILL-1', 'TO-FULFILL-2', 'TO-FULFILL-3', 'TO-FULFILL-4', 'TO-FULFILL-5'];
  for (const [i, code] of eligible.entries()) await createOrder({ code }, 100 - i);
  await createOrder({ code: 'DEMO-TO-FULFILL', demo: true }, 90);
  await createOrder({ code: 'BALANCE-DUE', settled: 500 }, 80);
  await createOrder({ code: 'PARTIAL-SHIP', quantity: 2, fulfilled: 1 }, 70);
  await createOrder({ code: 'CANCELLED-SETTLED', state: 'Cancelled' }, 60);
  await createOrder({ code: 'DELETED-TO-FULFILL', deleted: true }, 50);
  await createOrder({ code: 'FULLY-SHIPPED', fulfilled: 1 }, 40);
  await createOrder({ code: 'ALL-LINES-CANCELLED', cancelled: 1 }, 30);
  return createAdminSession(OWNER);
}

describe('GET /v1/admin/dashboard — demo-order exclusion', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('excludes is_demo orders from revenue, order count, and AOV', async () => {
    const token = await seed();
    const res = await app.request('/v1/admin/dashboard', {
      headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { store: { published: boolean }; revenue: number; orders: number; aov: number; recentOrders: Array<{ code: string; isDemo: boolean }> };

    // Only the real order's $100.00 counts — the $999,999.99 demo order does not.
    expect(body.revenue).toBe(10000);
    expect(body.orders).toBe(1);
    expect(body.aov).toBe(10000);
    expect(body.store.published).toBe(true);

    // The raw recent-orders feed still shows both, labeled, so the owner can
    // see the demo flow they just ran — only the aggregate KPIs are gated.
    const codes = body.recentOrders.map((o) => o.code).sort();
    expect(codes).toEqual(['DEMO-1', 'REAL-1']);
    const demoRow = body.recentOrders.find((o) => o.code === 'DEMO-1');
    expect(demoRow?.isDemo).toBe(true);
    const realRow = body.recentOrders.find((o) => o.code === 'REAL-1');
    expect(realRow?.isDemo).toBe(false);
  });
});

describe('GET /v1/admin/dashboard — To fulfill parity', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('matches canonical paid/unfulfilled Orders filters across pages and excludes edge cases', async () => {
    const token = await seedFulfillmentCases();
    const headers = { authorization: `Bearer ${token}`, 'x-store-slug': SLUG };
    const dashboardRes = await app.request('/v1/admin/dashboard', { headers });
    expect(dashboardRes.status).toBe(200);
    const dashboard = await dashboardRes.json() as { pendingFulfillment: number };

    const filters = 'paymentStatus=paid&fulfillmentStatus=unfulfilled&status=active&excludeDemo=1&pageSize=2';
    const firstRes = await app.request(`/v1/admin/orders?${filters}&page=1`, { headers });
    expect(firstRes.status).toBe(200);
    const first = await firstRes.json() as { items: Array<{ code: string }>; total: number; page: number; pageSize: number };
    const secondRes = await app.request(`/v1/admin/orders?${filters}&page=2`, { headers });
    const second = await secondRes.json() as { items: Array<{ code: string }>; total: number; page: number; pageSize: number };
    const thirdRes = await app.request(`/v1/admin/orders?${filters}&page=3`, { headers });
    const third = await thirdRes.json() as { items: Array<{ code: string }>; total: number; page: number; pageSize: number };

    expect(secondRes.status).toBe(200);
    expect(thirdRes.status).toBe(200);
    expect(dashboard.pendingFulfillment).toBe(first.total);
    expect([first.total, second.total, third.total]).toEqual([5, 5, 5]);
    expect([...first.items, ...second.items, ...third.items].map((o) => o.code).sort()).toEqual([
      'TO-FULFILL-1', 'TO-FULFILL-2', 'TO-FULFILL-3', 'TO-FULFILL-4', 'TO-FULFILL-5',
    ]);

    const exportRes = await app.request(`/v1/admin/export/orders?${filters}&columns=code&days=365`, { headers });
    expect(exportRes.status).toBe(200);
    expect((await exportRes.text()).trim().split('\n').slice(1).sort()).toEqual([
      'TO-FULFILL-1', 'TO-FULFILL-2', 'TO-FULFILL-3', 'TO-FULFILL-4', 'TO-FULFILL-5',
    ]);
  });
});
