/**
 * DB test — zero-cache stock rule: PATCH /v1/admin/variants/{id}/stock must
 * trigger an immediate catalog-manifest regeneration (manifest/stock-hook.js)
 * after the write commits, and must NOT trigger one when the request 404s
 * (variant not found — nothing was written).
 *
 * Mirrors routes/admin-orders.cancel.test.ts conventions: _test-DB guard +
 * TRUNCATE store CASCADE wipe + admin session via createAdminSession().
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';

const onStockChangedCalls: string[] = [];
vi.mock('../manifest/stock-hook.js', () => ({
  onStockChanged: (storeSlug: string) => { onStockChangedCalls.push(storeSlug); },
}));

import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminProducts } from './admin-products.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`admin-products stock test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'ffffffff-1111-1111-1111-111111111111';
const SLUG = 'admin-products-stock-test-store';
const ADMIN = 'ffffffff-1111-1111-1111-00000000000a';
const VARIANT = 'ffffffff-1111-1111-1111-00000000000b';

const app = new OpenAPIHono();
app.route('/', adminProducts);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seedStoreAdminAndVariant(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@admin-products-stock.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'V1', 1000) ON CONFLICT (id) DO NOTHING`);
  });
  return createAdminSession(ADMIN);
}

async function patchStock(id: string, onHand: number, token: string) {
  const res = await app.request(`/v1/admin/variants/${id}/stock`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify({ onHand }),
  });
  return { status: res.status, body: await res.json() };
}

let token = '';
beforeEach(async () => {
  await wipe();
  onStockChangedCalls.length = 0;
  token = await seedStoreAdminAndVariant();
});
afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('PATCH /v1/admin/variants/{id}/stock — zero-cache stock hook wiring', () => {
  it('triggers an immediate manifest regeneration for this store after the on-hand write commits', async () => {
    const res = await patchStock(VARIANT, 25, token);
    expect(res.status).toBe(200);
    expect(onStockChangedCalls).toEqual([SLUG]);
  });

  it('fires again on a second edit (no debounce/coalescing at the route level — every commit signals)', async () => {
    await patchStock(VARIANT, 25, token);
    await patchStock(VARIANT, 5, token);
    expect(onStockChangedCalls).toEqual([SLUG, SLUG]);
  });

  it('does not trigger the hook when the variant does not exist (nothing was written)', async () => {
    const res = await patchStock('ffffffff-0000-0000-0000-000000000000', 25, token);
    expect(res.status).toBe(404);
    expect(onStockChangedCalls).toEqual([]);
  });
});
