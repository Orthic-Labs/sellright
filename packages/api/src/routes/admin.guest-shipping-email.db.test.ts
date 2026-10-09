/**
 * DB tests — guest shipping notifications. A guest checkout carries no
 * customerId, only the contact email in order.metadata.contact.email. Every
 * shipped-email path (whole-order fulfill, partial fulfillment, bulk fulfill,
 * tracking import) must enqueue to that address, falling back to the account
 * email for registered customers — exactly like the refund email — and must
 * never send to anyone when no address resolves.
 *
 * Runs against a *_test database ONLY (wipes data).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { admin as adminRoutes } from './admin.js';
import { adminOrderOps } from './admin-order-ops.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`guest-shipping-email test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-0000000005a1';
const SLUG = 'guest-shipping-email-test-store';
const ADMIN = 'eeeeeeee-eeee-eeee-eeee-0000000005a2';
const CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-0000000005a3';

const app = new OpenAPIHono();
app.route('/', adminRoutes);
app.route('/', adminOrderOps);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

let token = '';
async function seed(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@guest-ship.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email) VALUES (${CUSTOMER}, ${STORE}, 'account@guest-ship.test') ON CONFLICT (id) DO NOTHING`);
  });
  return createAdminSession(ADMIN);
}

/** Paid order with one unfulfilled line. `customer` links the account; `contact` sets metadata.contact.email. */
async function seedOrder(code: string, opts: { customer?: boolean; contact?: string | null }): Promise<{ orderId: string; lineId: string }> {
  const metadata = opts.contact ? JSON.stringify({ contact: { email: opts.contact } }) : null;
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, customer_id, code, state, currency, grand_total, metadata)
      VALUES (gen_random_uuid(), ${STORE}, ${opts.customer ? CUSTOMER : null}, ${code}, 'Paid'::order_state, 'USD', 1000, ${metadata}::jsonb)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  const lineId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, 'SKU-G', 'Guest Item', 1, 1000, 1000, 1000, 0)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  return { orderId, lineId };
}

async function post(path: string, body: Record<string, unknown>) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function shippingRecipients(): Promise<string[]> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT recipient FROM email_outbox WHERE kind = 'shipping_notification' ORDER BY recipient`);
    return (r.rows as Array<{ recipient: string }>).map((x) => x.recipient);
  });
}

beforeEach(async () => { await wipe(); token = await seed(); });
afterAll(async () => { await wipe(); await pool.end(); });

describe('guest shipping notification recipient', () => {
  it('POST /fulfill emails the checkout contact of a guest order (no customerId)', async () => {
    await seedOrder('GS-1', { contact: 'Guest@Example.com' });
    const res = await post('/v1/admin/orders/GS-1/fulfill', { state: 'Shipped', trackingCode: 'T1', carrier: 'ups' });
    expect(res.status).toBe(200);
    expect(await shippingRecipients()).toEqual(['guest@example.com']);
  });

  it('POST /fulfill falls back to the account email for a registered customer without a contact email', async () => {
    await seedOrder('GS-2', { customer: true });
    expect((await post('/v1/admin/orders/GS-2/fulfill', { state: 'Shipped' })).status).toBe(200);
    expect(await shippingRecipients()).toEqual(['account@guest-ship.test']);
  });

  it('POST /fulfill prefers the checkout contact email over the linked account email', async () => {
    await seedOrder('GS-3', { customer: true, contact: 'checkout@example.com' });
    expect((await post('/v1/admin/orders/GS-3/fulfill', { state: 'Shipped' })).status).toBe(200);
    expect(await shippingRecipients()).toEqual(['checkout@example.com']);
  });

  it('POST /fulfill still ships but sends nothing when no address resolves', async () => {
    await seedOrder('GS-4', {});
    expect((await post('/v1/admin/orders/GS-4/fulfill', { state: 'Shipped' })).status).toBe(200);
    expect(await shippingRecipients()).toEqual([]);
  });

  it('POST /fulfillments (partial) emails the guest contact, and notifyCustomer=false suppresses it', async () => {
    const a = await seedOrder('GS-5', { contact: 'partial@example.com' });
    const b = await seedOrder('GS-6', { contact: 'quiet@example.com' });
    expect((await post('/v1/admin/orders/GS-5/fulfillments', { lines: [{ orderLineId: a.lineId, quantity: 1 }] })).status).toBe(200);
    expect((await post('/v1/admin/orders/GS-6/fulfillments', { lines: [{ orderLineId: b.lineId, quantity: 1 }], notifyCustomer: false })).status).toBe(200);
    expect(await shippingRecipients()).toEqual(['partial@example.com']);
  });

  it('POST /bulk-fulfill emails guest contacts', async () => {
    await seedOrder('GS-7', { contact: 'bulk-guest@example.com' });
    await seedOrder('GS-8', { customer: true });
    const res = await post('/v1/admin/orders/bulk-fulfill', { orders: [{ code: 'GS-7', trackingCode: 'B1' }, { code: 'GS-8', trackingCode: 'B2' }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 2 });
    expect(await shippingRecipients()).toEqual(['account@guest-ship.test', 'bulk-guest@example.com']);
  });

  it('POST /import-tracking emails guest contacts and reports them queued', async () => {
    await seedOrder('GS-9', { contact: 'import-guest@example.com' });
    const res = await post('/v1/admin/import-tracking', { rows: [{ code: 'GS-9', tracking: '1Z999AA10123456784', carrier: 'ups' }], notify: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 1, emailsQueued: 1 });
    expect(await shippingRecipients()).toEqual(['import-guest@example.com']);
  });
});
