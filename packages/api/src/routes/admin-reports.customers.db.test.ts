/**
 * C1 regression: GET /v1/admin/customers must report the same order count and
 * lifetime spend as the customer detail endpoint. The list used a correlated
 * subquery whose bare `"id"` bound to order.id, so every row read 0 / $0.
 * Runs against a *_test database ONLY (wipes data).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminReports } from './admin-reports.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`customers list test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SLUG = 'customers-list-test-store';
const ADMIN = 'cccccccc-cccc-4ccc-8ccc-00000000000a';
const BUYER = 'cccccccc-cccc-4ccc-8ccc-00000000000b';
const LURKER = 'cccccccc-cccc-4ccc-8ccc-00000000000c';

const app = new OpenAPIHono();
app.route('/', adminReports);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

let token = '';
beforeEach(async () => {
  await wipe();
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG})`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@customers.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner')`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, first_name, last_name) VALUES (${BUYER}, ${STORE}, 'buyer@customers.test', 'George', 'Flint')`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${LURKER}, ${STORE}, 'lurker@customers.test')`);
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, customer_id, grand_total, placed_at)
      VALUES (gen_random_uuid(), ${STORE}, 'C-PAID-1', 'Paid'::order_state, 'USD', ${BUYER}, 4200, now())`);
    // Unpaid + demo orders must not count.
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, customer_id, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, 'C-PEND-1', 'PendingPayment'::order_state, 'USD', ${BUYER}, 9900)`);
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, customer_id, grand_total, is_demo, placed_at)
      VALUES (gen_random_uuid(), ${STORE}, 'C-DEMO-1', 'Paid'::order_state, 'USD', ${BUYER}, 7700, true, now())`);
  });
  token = await createAdminSession(ADMIN);
});
afterEach(wipe);
afterAll(() => pool.end());

const headers = () => ({ authorization: `Bearer ${token}`, 'x-store-slug': SLUG });

describe('GET /v1/admin/customers aggregates', () => {
  it('reports paid order count and spend per customer, matching the detail endpoint', async () => {
    const res = await app.request('/v1/admin/customers', { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; email: string; orders: number; spent: number }> };
    const buyer = body.items.find((c) => c.id === BUYER)!;
    const lurker = body.items.find((c) => c.id === LURKER)!;
    expect(buyer.orders).toBe(1);
    expect(buyer.spent).toBe(4200);
    expect(lurker.orders).toBe(0);
    expect(lurker.spent).toBe(0);

    const detail = await app.request(`/v1/admin/customers/${BUYER}`, { headers: headers() });
    const d = (await detail.json()) as { orderCount: number; spent: number };
    expect(d.orderCount).toBe(buyer.orders);
    expect(d.spent).toBe(buyer.spent);
  });
});
