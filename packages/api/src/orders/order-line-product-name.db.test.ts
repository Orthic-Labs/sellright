/**
 * DB tests — product name on order lines (issue #346, migration 0111).
 *
 *   1. a shop checkout snapshots the product name on the line; the invoice and packing slip read "Product · Variant"
 *   2. renaming the product later never rewrites the order's history
 *   3. a variant swap on an existing line re-snapshots the new variant's product
 *   4. a line without a variant (imported history) keeps product_name NULL and its own variant_name
 *
 * Runs against a *_test database ONLY (wipes data).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { rateLimitBackend } from '../auth/rate-limit-backend.js';
import { checkout } from '../routes/checkout.js';
import { adminOrders } from '../routes/admin-orders.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'order-line-product-name.db.test.ts');

const STORE = 'ffffffff-0346-4000-8000-000000000001';
const SLUG = 'line-name-test-store';
const OWNER = 'ffffffff-0346-4000-8000-000000000002';
const SHIRT = 'ffffffff-0346-4000-8000-000000000003';
const LONG = 'ffffffff-0346-4000-8000-000000000004';
const MEDIUM_BLACK = 'ffffffff-0346-4000-8000-000000000005';
const LONG_MEDIUM_BLACK = 'ffffffff-0346-4000-8000-000000000006';

const app = new OpenAPIHono();
app.route('/', checkout);
app.route('/', adminOrders);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate) VALUES (${STORE}, ${SLUG}, 'Line names', 'USD', 0)`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES
      (${SHIRT}, ${STORE}, 'short', 'Short Sleeve Button-Up Shirt', 'active'), (${LONG}, ${STORE}, 'long', 'Long Sleeve Button-Up Shirt', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type) VALUES
      (${MEDIUM_BLACK}, ${STORE}, ${SHIRT}, 'SS-M-BLK', 'Medium - Midnight black', 7500, 'digital_download'),
      (${LONG_MEDIUM_BLACK}, ${STORE}, ${LONG}, 'LS-M-BLK', 'Medium - Midnight black', 8000, 'digital_download')`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${MEDIUM_BLACK}, ${STORE}, 100, 0), (${LONG_MEDIUM_BLACK}, ${STORE}, 100, 0)`);
  });
  await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, 'owner@lines.test')`, [OWNER]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [OWNER, STORE]);
  return createAdminSession(OWNER);
}

async function shopCheckout(): Promise<string> {
  const res = await app.request('/v1/shop/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-store-slug': SLUG },
    body: JSON.stringify({ items: [{ sku: 'SS-M-BLK', quantity: 1 }], email: 'buyer@lines.test' }),
  }, { remoteAddr: '10.34.6.1' });
  const body = await res.json() as { code: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.code;
}

const lineOf = async (code: string) => (await withStore(STORE, (tx) => tx.execute(sql`
  SELECT ol.id, ol.variant_name, ol.product_name FROM order_line ol JOIN "order" o ON o.id = ol.order_id WHERE o.code = ${code}`))).rows[0] as
  { id: string; variant_name: string; product_name: string | null };

const doc = async (token: string, code: string, kind: 'invoice' | 'packing-slip') => {
  const res = await app.request(`/v1/admin/orders/${encodeURIComponent(code)}/${kind}`, { headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG } });
  expect(res.status).toBe(200);
  return await res.json() as { lines: Array<{ name: string }> };
};

let token = '';
beforeEach(async () => {
  await rateLimitBackend().clear('checkout-ip', `10.34.6.1|${STORE}`);
  await wipe();
  token = await seed();
});
afterAll(async () => { await wipe(); await pool.end(); });

describe('order line product name (#346)', () => {
  it('a checkout snapshots the product name; invoice and packing slip name product and variant', async () => {
    const code = await shopCheckout();
    expect(await lineOf(code)).toMatchObject({ variant_name: 'Medium - Midnight black', product_name: 'Short Sleeve Button-Up Shirt' });
    expect((await doc(token, code, 'invoice')).lines.map((l) => l.name)).toEqual(['Short Sleeve Button-Up Shirt · Medium · Midnight black']);
    expect((await doc(token, code, 'packing-slip')).lines.map((l) => l.name)).toEqual(['Short Sleeve Button-Up Shirt · Medium · Midnight black']);
  });

  it('renaming the product later keeps the name the order was placed with', async () => {
    const code = await shopCheckout();
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE product SET name = 'Renamed Shirt' WHERE id = ${SHIRT}`));
    expect((await lineOf(code)).product_name).toBe('Short Sleeve Button-Up Shirt');
  });

  it('a variant swap on the line re-snapshots the new product', async () => {
    const code = await shopCheckout();
    const { id } = await lineOf(code);
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE order_line SET variant_id = ${LONG_MEDIUM_BLACK}, variant_sku = 'LS-M-BLK' WHERE id = ${id}`));
    expect((await lineOf(code)).product_name).toBe('Long Sleeve Button-Up Shirt');
  });

  it('a line without a variant (imported history) keeps product_name NULL and reads as its variant name', async () => {
    const code = await shopCheckout();
    await withStore(STORE, async (tx) => {
      const [o] = (await tx.execute(sql`SELECT id FROM "order" WHERE code = ${code}`)).rows as Array<{ id: string }>;
      await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total)
        VALUES (${STORE}, ${o!.id}, 'IMPORTED', 'Necro bead - Ultem', 1, 500, 500, 500)`);
    });
    const names = (await doc(token, code, 'packing-slip')).lines.map((l) => l.name).sort();
    expect(names).toEqual(['Necro bead - Ultem', 'Short Sleeve Button-Up Shirt · Medium · Midnight black']);
  });
});
