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
import { adminDashboard } from './admin-dashboard.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-dashboard.demo-order.db.test.ts');

const STORE = 'eeeeeeee-0000-0000-0000-00000000da01';
const SLUG = 'demo-order-test-store';
const OWNER = 'eeeeeeee-0000-0000-0000-00000000da02';
const ORDER_REAL = 'eeeeeeee-0000-0000-0000-00000000da03';
const ORDER_DEMO = 'eeeeeeee-0000-0000-0000-00000000da04';

const app = new OpenAPIHono();
app.route('/', adminDashboard);

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
