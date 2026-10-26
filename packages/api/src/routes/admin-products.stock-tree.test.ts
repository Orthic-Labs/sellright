/**
 * DB test — GET /v1/admin/stock/tree (Bulk Stock page read model, #396; the previous platform
 * order-tools BulkStockPage parity): products -> variants with live stock,
 * disabled/draft rows included (the page filters them client-side), deleted
 * rows and variant-less products omitted, missing stock rows read as 0.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminProducts } from './admin-products.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'admin-products.stock-tree.test.ts');

const STORE = 'eeeeeeee-3333-3333-3333-333333333333';
const SLUG = 'stock-tree-test-store';
const ADMIN = 'eeeeeeee-3333-3333-3333-00000000000a';
const P_ACTIVE = 'eeeeeeee-3333-3333-3333-0000000000a1';
const P_DRAFT = 'eeeeeeee-3333-3333-3333-0000000000a2';
const P_EMPTY = 'eeeeeeee-3333-3333-3333-0000000000a3';
const P_DELETED = 'eeeeeeee-3333-3333-3333-0000000000a4';
const V_A1 = 'eeeeeeee-3333-3333-3333-0000000000b1';
const V_A2_DISABLED = 'eeeeeeee-3333-3333-3333-0000000000b2';
const V_A3_NO_STOCK = 'eeeeeeee-3333-3333-3333-0000000000b3';
const V_A4_DELETED = 'eeeeeeee-3333-3333-3333-0000000000b4';
const V_D1 = 'eeeeeeee-3333-3333-3333-0000000000b5';
const V_X1 = 'eeeeeeee-3333-3333-3333-0000000000b6';

const app = new OpenAPIHono();
app.route('/', adminProducts);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@stock-tree.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${P_ACTIVE}, ${STORE}, 'alpha', 'Alpha', 'active')`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${P_DRAFT}, ${STORE}, 'bravo', 'Bravo', 'draft')`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${P_EMPTY}, ${STORE}, 'charlie', 'Charlie', 'active')`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status, deleted_at) VALUES (${P_DELETED}, ${STORE}, 'delta', 'Delta', 'active', now())`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${V_A1}, ${STORE}, ${P_ACTIVE}, 'A1', 'Small', 1000)`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, enabled) VALUES (${V_A2_DISABLED}, ${STORE}, ${P_ACTIVE}, 'A2', 'Medium', 1000, false)`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${V_A3_NO_STOCK}, ${STORE}, ${P_ACTIVE}, 'A3', 'Large', 1000)`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, deleted_at) VALUES (${V_A4_DELETED}, ${STORE}, ${P_ACTIVE}, 'A4', 'Gone', 1000, now())`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${V_D1}, ${STORE}, ${P_DRAFT}, 'B1', 'Only', 1000)`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${V_X1}, ${STORE}, ${P_DELETED}, 'D1', 'Orphan', 1000)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${V_A1}, ${STORE}, 10, 3)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${V_A2_DISABLED}, ${STORE}, 0, 0)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${V_D1}, ${STORE}, 4, 0)`);
  });
  return createAdminSession(ADMIN);
}

let token = '';
beforeEach(async () => {
  await wipe();
  token = await seed();
});
afterAll(async () => {
  await wipe();
  await pool.end();
});

type Tree = { items: Array<{ id: string; name: string; enabled: boolean; variants: Array<{ id: string; sku: string; enabled: boolean; onHand: number; allocated: number }> }>; total: number; truncated: boolean };

describe('GET /v1/admin/stock/tree', () => {
  it('returns products with variants and stock; omits deleted rows and variant-less products', async () => {
    const res = await app.request('/v1/admin/stock/tree', { headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Tree;
    expect(body.truncated).toBe(false);
    expect(body.total).toBe(2);
    expect(body.items.map((p) => [p.name, p.enabled])).toEqual([['Alpha', true], ['Bravo', false]]);
    const alpha = body.items[0]!;
    expect(alpha.variants.map((v) => v.sku).sort()).toEqual(['A1', 'A2', 'A3']);
    const bySku = Object.fromEntries(alpha.variants.map((v) => [v.sku, v]));
    expect(bySku.A1).toMatchObject({ enabled: true, onHand: 10, allocated: 3 });
    expect(bySku.A2).toMatchObject({ enabled: false, onHand: 0, allocated: 0 });
    expect(bySku.A3).toMatchObject({ enabled: true, onHand: 0, allocated: 0 }); // no stock row -> 0
    expect(body.items[1]!.variants).toEqual([expect.objectContaining({ sku: 'B1', onHand: 4 })]);
  });

  it('requires an authenticated admin session', async () => {
    const res = await app.request('/v1/admin/stock/tree', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(401);
  });
});
