/**
 * #380 (Adrian: "emails go when order is fulfilled, there's no 2 ways about it"): every way of shipping an order queues
 * exactly one shipping email per fulfilment, guests included (their checkout contact email), with no opt-out: a request
 * still carrying the old notify / notifyCustomer flag set to false emails anyway. Real handlers over a *_test database.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminOrderOps } from './admin-order-ops.js';
import { admin as adminRoutes } from './admin.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'shipping-email.db.test.ts');

const STORE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0380';
const SLUG = 'ship-email-test-store';
const ADMIN = 'bbbbbbbb-bbbb-4bbb-8bbb-00000000000a';
const VAR = 'bbbbbbbb-bbbb-4bbb-8bbb-00000000000b';

const app = new OpenAPIHono();
app.route('/', adminOrderOps);
app.route('/', adminRoutes);
let token = '';
const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

/** A paid guest order (no customer) whose only email is the checkout contact. Returns its first line id. */
async function guestOrder(code: string, qty = 1): Promise<string> {
  return withStore(STORE, async (tx) => {
    const o = await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, subtotal, grand_total, placed_at, metadata, shipping_address)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, 'Paid', 'USD', 2500, 2500, now(), ${JSON.stringify({ contact: { email: `${code.toLowerCase()}@guest.test` } })}::jsonb,
        ${JSON.stringify({ fullName: 'Guest Person', line1: '1 St', city: 'Reno', province: 'NV', postalCode: '89501', country: 'US' })}::jsonb) RETURNING id`);
    const id = (o.rows[0] as { id: string }).id;
    const l = await tx.execute(sql`INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${id}, ${VAR}, 'SKU-S', 'Knife', ${qty}, 2500, ${qty * 2500}, ${qty * 2500}, 0) RETURNING id`);
    await tx.execute(sql`INSERT INTO payment (store_id, order_id, amount, method, state) VALUES (${STORE}, ${id}, 2500, 'nmi', 'Settled')`);
    return (l.rows[0] as { id: string }).id;
  });
}

/** Shipping emails queued for this order's guest address. */
const shippingEmails = (code: string) => withStore(STORE, async (tx) =>
  ((await tx.execute(sql`SELECT count(*)::int AS n FROM email_outbox WHERE kind = 'shipping_notification' AND recipient = ${`${code.toLowerCase()}@guest.test`}`)).rows[0] as { n: number }).n);
const notifyColumn = (code: string) => withStore(STORE, async (tx) =>
  ((await tx.execute(sql`SELECT array_agg(f.notify_customer) AS v FROM fulfillment f JOIN "order" o ON o.id = f.order_id WHERE o.code = ${code}`)).rows[0] as { v: boolean[] }).v);

beforeEach(async () => {
  await wipe();
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD')`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@ship.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner')`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-0000000000f1', ${STORE}, 'p', 'P', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VAR}, ${STORE}, 'bbbbbbbb-bbbb-4bbb-8bbb-0000000000f1', 'SKU-S', 'Knife', 2500)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VAR}, ${STORE}, 100, 20)`);
  });
  token = await createAdminSession(ADMIN);
});
afterEach(wipe);
afterAll(() => pool.end());

describe('shipping email is always sent (#380)', () => {
  it('single fulfil: one email to the guest; shipping again does not email twice', async () => {
    await guestOrder('SE-1');
    expect((await post('/v1/admin/orders/SE-1/fulfill', { state: 'Shipped', trackingCode: '1Z999AA10123456784', carrier: 'UPS' })).status).toBe(200);
    await post('/v1/admin/orders/SE-1/fulfill', { state: 'Shipped', trackingCode: '1Z999AA10123456784', carrier: 'UPS' });
    expect(await shippingEmails('SE-1')).toBe(1);
  });

  it('bulk "Mark shipped": one email per order', async () => {
    await guestOrder('SE-2'); await guestOrder('SE-3');
    expect((await post('/v1/admin/orders/bulk-fulfill', { orders: [{ code: 'SE-2', state: 'Shipped' }, { code: 'SE-3', state: 'Shipped' }] })).status).toBe(200);
    expect([await shippingEmails('SE-2'), await shippingEmails('SE-3')]).toEqual([1, 1]);
  });

  it('partial fulfilment from the order page: one email per fulfilment, even with the old notifyCustomer=false', async () => {
    const line = await guestOrder('SE-4', 2);
    expect((await post('/v1/admin/orders/SE-4/fulfillments', { lines: [{ orderLineId: line, quantity: 1 }], trackingCode: 'T-1', notifyCustomer: false })).status).toBe(200);
    expect(await shippingEmails('SE-4')).toBe(1);
    expect((await post('/v1/admin/orders/SE-4/fulfillments', { lines: [{ orderLineId: line, quantity: 1 }], trackingCode: 'T-2' })).status).toBe(200);
    expect(await shippingEmails('SE-4')).toBe(2); // second box, its own email
    expect(await notifyColumn('SE-4')).toEqual([true, true]);
  });

  it('CSV upload and manual entry: one email per order, even with the old notify=false', async () => {
    await guestOrder('SE-5'); await guestOrder('SE-6');
    const csv = await post('/v1/admin/import-tracking', { csv: 'OrderId,shpack_trackingid\nSE-5,9400111899223817200001\n', notify: false, source: 'csv' });
    expect(csv.status).toBe(200);
    expect((await csv.json() as { emailsQueued: number }).emailsQueued).toBe(1);
    const manual = await post('/v1/admin/import-tracking', { rows: [{ code: 'SE-6', tracking: '1Z999AA10123456785' }], source: 'grid' });
    expect((await manual.json() as { emailsQueued: number }).emailsQueued).toBe(1);
    expect([await shippingEmails('SE-5'), await shippingEmails('SE-6')]).toEqual([1, 1]);
    expect(await notifyColumn('SE-5')).toEqual([true]);
  });
});
