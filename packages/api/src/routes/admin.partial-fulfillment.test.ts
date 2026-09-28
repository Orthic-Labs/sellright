/**
 * DB tests — admin-essentials partial fulfillment:
 * POST /v1/admin/orders/{code}/fulfillments creates ONE fulfillment scoped to
 * selected lines/quantities (distinct from the existing all-or-nothing
 * POST /fulfill, which is untouched and still used by CSV/bulk-import).
 *
 * Runs against sellright_test ONLY (wipes data). Mirrors
 * admin-orders.refund.test.ts / admin-products.stock.test.ts conventions:
 * _test-DB guard + TRUNCATE store CASCADE wipe + seed helpers under
 * withStore(), real Hono handlers via app.request() so auth + RLS run as in
 * production.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { admin as adminRoutes } from './admin.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`partial-fulfillment test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SLUG = 'partial-fulfillment-test-store';
const ADMIN = 'eeeeeeee-eeee-eeee-eeee-00000000000a';
const VARIANT_A = 'eeeeeeee-eeee-eeee-eeee-00000000000b';
const VARIANT_B = 'eeeeeeee-eeee-eeee-eeee-00000000000c';
const CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-00000000000d';
// Zod's `.uuid()` (used on the route's `locationId` field) enforces RFC4122
// version/variant nibbles except for the special-cased nil/max UUIDs — a
// same-shaped-as-the-rest 'eeee...' literal fails that check where it's
// actually validated (unlike STORE/ADMIN/VARIANT_* above, which only ever
// reach raw SQL / withStore, never a zod .uuid() field). Version 4 + variant
// 8 here keeps it valid while staying visually distinguishable.
const LOCATION = 'eeeeeeee-eeee-4eee-8eee-00000000000e';

const app = new OpenAPIHono();
app.route('/', adminRoutes);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@partial-fulfillment.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${CUSTOMER}, ${STORE}, 'shopper@partial-fulfillment.test') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO location (id, store_id, name, code, is_default, enabled) VALUES (${LOCATION}, ${STORE}, 'Main Warehouse', 'main', true, true) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT_A}, ${STORE}, ${pid}, 'SKU-A', 'Variant A', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT_B}, ${STORE}, ${pid}, 'SKU-B', 'Variant B', 500) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT_A}, ${STORE}, 10, 4) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 10, allocated = 4`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT_B}, ${STORE}, 10, 2) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 10, allocated = 2`);
  });
  return createAdminSession(ADMIN);
}

/** Seed a Paid order with two lines (qty 3 of A, qty 2 of B), unfulfilled. */
async function seedPaidOrder(code: string, withCustomer = true): Promise<{ orderId: string; lineA: string; lineB: string }> {
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, customer_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${withCustomer ? CUSTOMER : null}, ${code}, 'Paid'::order_state, 'USD', 4000)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  const lineA = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT_A}, 'SKU-A', 'Variant A', 3, 1000, 3000, 3000, 0)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  const lineB = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT_B}, 'SKU-B', 'Variant B', 2, 500, 1000, 1000, 0)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  return { orderId, lineA, lineB };
}

async function createFulfillment(code: string, body: Record<string, unknown>) {
  const res = await app.request(`/v1/admin/orders/${code}/fulfillments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function stockRow(variantId: string) {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT on_hand, allocated FROM stock WHERE variant_id = ${variantId}`);
    return r.rows[0] as { on_hand: number; allocated: number };
  });
}

let token = '';
beforeEach(async () => { await wipe(); token = await seed(); });
afterAll(async () => { await wipe(); await pool.end(); });

describe('POST /v1/admin/orders/{code}/fulfillments — partial fulfillment', () => {
  it('ships a subset of one line, decrementing only that quantity from stock and order_line.fulfilled_qty', async () => {
    const { orderId, lineA } = await seedPaidOrder('PF-1');
    const res = await createFulfillment('PF-1', { lines: [{ orderLineId: lineA, quantity: 2 }], trackingCode: 'TRACK1', carrier: 'ups' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code: 'PF-1', state: 'Shipped' });

    const stock = await stockRow(VARIANT_A);
    expect(stock).toMatchObject({ on_hand: 8, allocated: 2 }); // 10-2, 4-2

    const lineRow = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT fulfilled_qty FROM order_line WHERE id = ${lineA}`);
      return r.rows[0] as { fulfilled_qty: number };
    });
    expect(lineRow.fulfilled_qty).toBe(2);

    const flCount = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT quantity FROM fulfillment_line WHERE order_line_id = ${lineA}`);
      return r.rows as { quantity: number }[];
    });
    expect(flCount).toEqual([{ quantity: 2 }]);

    // Line B is untouched — this is a PARTIAL fulfillment.
    const stockB = await stockRow(VARIANT_B);
    expect(stockB).toMatchObject({ on_hand: 10, allocated: 2 });
    void orderId;
  });

  it('supports two separate partial fulfillments on the same order (split shipment)', async () => {
    const { lineA, lineB } = await seedPaidOrder('PF-2');
    const first = await createFulfillment('PF-2', { lines: [{ orderLineId: lineA, quantity: 1 }] });
    const second = await createFulfillment('PF-2', { lines: [{ orderLineId: lineB, quantity: 2 }] });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.fulfillmentId).not.toBe(second.body.fulfillmentId);

    const fulfillments = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int AS n FROM fulfillment WHERE order_id = (SELECT id FROM "order" WHERE code = 'PF-2')`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(fulfillments).toBe(2);
  });

  it('rejects a quantity greater than what remains unfulfilled on the line', async () => {
    const { lineA } = await seedPaidOrder('PF-3');
    const res = await createFulfillment('PF-3', { lines: [{ orderLineId: lineA, quantity: 4 }] }); // only 3 ordered
    expect(res.status).toBe(409);
  });

  it('rejects a duplicate orderLineId within the same request', async () => {
    const { lineA } = await seedPaidOrder('PF-4');
    const res = await createFulfillment('PF-4', { lines: [{ orderLineId: lineA, quantity: 1 }, { orderLineId: lineA, quantity: 1 }] });
    expect(res.status).toBe(409);
  });

  it('rejects an unknown/disabled locationId', async () => {
    const { lineA } = await seedPaidOrder('PF-5');
    const res = await createFulfillment('PF-5', { lines: [{ orderLineId: lineA, quantity: 1 }], locationId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(409);
  });

  it('decrements the per-location on-hand when a valid locationId is given', async () => {
    await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO stock_location (store_id, variant_id, location_id, on_hand) VALUES (${STORE}, ${VARIANT_A}, ${LOCATION}, 5)`));
    const { lineA } = await seedPaidOrder('PF-6');
    const res = await createFulfillment('PF-6', { lines: [{ orderLineId: lineA, quantity: 2 }], locationId: LOCATION });
    expect(res.status).toBe(200);
    const row = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT on_hand FROM stock_location WHERE variant_id = ${VARIANT_A} AND location_id = ${LOCATION}`);
      return r.rows[0] as { on_hand: number };
    });
    expect(row.on_hand).toBe(3);
  });

  it('notifyCustomer=false skips the customer email but the fulfillment still ships (webhook still fires)', async () => {
    const { lineA } = await seedPaidOrder('PF-7');
    const res = await createFulfillment('PF-7', { lines: [{ orderLineId: lineA, quantity: 1 }], notifyCustomer: false });
    expect(res.status).toBe(200);
    const emails = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int AS n FROM email_outbox WHERE recipient = 'shopper@partial-fulfillment.test'`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(emails).toBe(0);
    const fulfillment = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT notify_customer FROM fulfillment WHERE order_id = (SELECT id FROM "order" WHERE code = 'PF-7')`);
      return r.rows[0] as { notify_customer: boolean };
    });
    expect(fulfillment.notify_customer).toBe(false);
  });

  it('notifyCustomer=true (default) enqueues exactly one customer email per fulfillment', async () => {
    const { lineA, lineB } = await seedPaidOrder('PF-8');
    await createFulfillment('PF-8', { lines: [{ orderLineId: lineA, quantity: 1 }] });
    await createFulfillment('PF-8', { lines: [{ orderLineId: lineB, quantity: 1 }] });
    const emails = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int AS n FROM email_outbox WHERE recipient = 'shopper@partial-fulfillment.test'`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(emails).toBe(2); // one per fulfillment — distinct dedupeKeys
  });

  it('records the acting admin on the stock_movement row', async () => {
    const { lineA } = await seedPaidOrder('PF-9');
    await createFulfillment('PF-9', { lines: [{ orderLineId: lineA, quantity: 1 }] });
    const row = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT actor, reason, delta FROM stock_movement WHERE variant_id = ${VARIANT_A} ORDER BY created_at DESC LIMIT 1`);
      return r.rows[0] as { actor: string; reason: string; delta: number };
    });
    expect(row).toMatchObject({ actor: 'owner@partial-fulfillment.test', reason: 'fulfillment', delta: -1 });
  });

  it('404s for an unknown order code, 409 for a non-Paid order', async () => {
    const missing = await createFulfillment('NOPE', { lines: [{ orderLineId: '00000000-0000-0000-0000-000000000000', quantity: 1 }] });
    expect(missing.status).toBe(404);

    const { lineA } = await seedPaidOrder('PF-10');
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET state = 'Cancelled' WHERE code = 'PF-10'`));
    const res = await createFulfillment('PF-10', { lines: [{ orderLineId: lineA, quantity: 1 }] });
    expect(res.status).toBe(409);
  });
});
