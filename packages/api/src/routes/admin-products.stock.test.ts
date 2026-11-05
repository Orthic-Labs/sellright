/**
 * DB test — zero-cache stock rule: PATCH /v1/admin/variants/{id}/stock must
 * trigger an immediate catalog-manifest regeneration (manifest/stock-hook.js)
 * after the write commits, and must NOT trigger one when the request 404s
 * (variant not found — nothing was written).
 *
 * Mirrors routes/admin-orders.cancel.test.ts conventions: _test-DB guard +
 * TRUNCATE store CASCADE wipe + admin session via createAdminSession().
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
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
assertTestDatabase(DB, 'admin-products.stock.test.ts');

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

async function patchStock(id: string, onHand: number, token: string, expectedOnHand?: number) {
  const res = await app.request(`/v1/admin/variants/${id}/stock`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify({ onHand, expectedOnHand }),
  });
  return { status: res.status, body: await res.json() };
}

async function patchVariant(id: string, body: Record<string, unknown>, token: string) {
  const res = await app.request(`/v1/admin/variants/${id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as { updatedAt?: string; error?: string } };
}

const onHandNow = () => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT on_hand FROM stock WHERE variant_id = ${VARIANT}`);
  return (r.rows[0] as { on_hand: number } | undefined)?.on_hand;
});

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

describe('#406 conflict checks — a stale editor cannot overwrite a newer variant or stock level', () => {
  it('writes on-hand when expectedOnHand still matches, and 409s without writing once stock moved', async () => {
    expect((await patchStock(VARIANT, 10, token, 0)).status).toBe(200);
    // A fulfilment (or another admin) moves stock to 9 while the editor still shows 10.
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE stock SET on_hand = 9 WHERE variant_id = ${VARIANT}`));
    onStockChangedCalls.length = 0;
    const res = await patchStock(VARIANT, 12, token, 10);
    expect(res.status).toBe(409);
    expect(await onHandNow()).toBe(9);
    expect(onStockChangedCalls).toEqual([]);
  });

  it('keeps the old absolute write when expectedOnHand is omitted', async () => {
    await patchStock(VARIANT, 10, token);
    expect((await patchStock(VARIANT, 3, token)).status).toBe(200);
    expect(await onHandNow()).toBe(3);
  });

  it('409s a variant PATCH whose expectedUpdatedAt is older than the row, and returns the new stamp on success', async () => {
    const first = await patchVariant(VARIANT, { price: 1100, expectedUpdatedAt: new Date(Date.now() + 60_000).toISOString() }, token);
    expect(first.status).toBe(200);
    expect(first.body.updatedAt).toEqual(expect.any(String));
    const stale = await patchVariant(VARIANT, { price: 1200, expectedUpdatedAt: new Date(Date.parse(first.body.updatedAt!) - 1000).toISOString() }, token);
    expect(stale.status).toBe(409);
    const price = await withStore(STORE, async (tx) => (await tx.execute(sql`SELECT price FROM product_variant WHERE id = ${VARIANT}`)).rows[0] as { price: number });
    expect(price.price).toBe(1100);
    expect((await patchVariant(VARIANT, { price: 1300, expectedUpdatedAt: first.body.updatedAt }, token)).status).toBe(200);
  });
});
