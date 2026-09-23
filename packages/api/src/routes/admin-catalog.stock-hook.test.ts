/**
 * DB test — zero-cache stock rule: routes/admin-catalog.ts's two live stock
 * writes (POST .../variants create-with-initial-stock, PATCH
 * .../location-stock aggregate recompute) must trigger an immediate
 * catalog-manifest regeneration (manifest/stock-hook.js) right after their
 * own transaction commits.
 *
 * Mirrors routes/admin-products.stock.test.ts / routes/admin.stock-hook.test.ts
 * conventions: _test-DB guard + TRUNCATE store CASCADE wipe + admin session
 * via createAdminSession().
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
import { adminCatalog } from './admin-catalog.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`admin-catalog stock-hook test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'cccc1111-1111-1111-1111-111111111111';
const SLUG = 'admin-catalog-stock-hook-test-store';
const ADMIN = 'cccc1111-1111-1111-1111-00000000000a';
const PRODUCT = 'cccc1111-1111-1111-1111-00000000000c';
const VARIANT = 'cccc1111-1111-1111-1111-00000000000b';
const LOCATION = 'cccc1111-1111-1111-1111-00000000000d';

const app = new OpenAPIHono();
app.route('/', adminCatalog);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seedStoreAdminProductAndLocation(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@admin-catalog-stock-hook.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'p', 'P', 'active') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO location (id, store_id, name, code) VALUES (${LOCATION}, ${STORE}, 'Main', 'main') ON CONFLICT (id) DO NOTHING`);
  });
  return createAdminSession(ADMIN);
}

async function createVariant(token: string, body: Record<string, unknown>) {
  const res = await app.request(`/v1/admin/products/${PRODUCT}/variants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function seedPhysicalVariant(): Promise<void> {
  await withStore(STORE, (tx) => tx.execute(sql`
    INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type)
    VALUES (${VARIANT}, ${STORE}, ${PRODUCT}, 'LOC-SKU', 'V1', 1000, 'physical') ON CONFLICT (id) DO NOTHING`));
}

async function locationStock(id: string, token: string, onHand: number) {
  const res = await app.request(`/v1/admin/variants/${id}/location-stock`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify({ locationId: LOCATION, onHand }),
  });
  return { status: res.status, body: await res.json() };
}

let token = '';
beforeEach(async () => {
  await wipe();
  onStockChangedCalls.length = 0;
  token = await seedStoreAdminProductAndLocation();
});
afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('routes/admin-catalog.ts — zero-cache stock hook wiring', () => {
  it('creating a PHYSICAL variant with initial stock fires the hook once', async () => {
    const res = await createVariant(token, { sku: 'PHYS-1', name: 'Physical', price: 1000, onHand: 12, fulfillmentType: 'physical' });
    expect(res.status).toBe(200);
    expect(onStockChangedCalls).toEqual([SLUG]);
    const [row] = await withStore(STORE, (tx) => tx.execute(sql`SELECT on_hand, allocated FROM stock WHERE variant_id = ${(res.body as { id: string }).id}`).then((r) => r.rows as { on_hand: number; allocated: number }[]));
    expect(row).toMatchObject({ on_hand: 12, allocated: 0 });
  });

  it('creating a PHYSICAL variant with zero initial stock still fires the hook (a stock row was created)', async () => {
    const res = await createVariant(token, { sku: 'PHYS-2', name: 'Physical Zero', price: 1000, onHand: 0, fulfillmentType: 'physical' });
    expect(res.status).toBe(200);
    expect(onStockChangedCalls).toEqual([SLUG]);
  });

  it('creating a non-physical (digital) variant never touches stock and never fires the hook', async () => {
    const res = await createVariant(token, { sku: 'DIGI-1', name: 'Digital', price: 1000, onHand: 0, fulfillmentType: 'digital_download' });
    expect(res.status).toBe(200);
    expect(onStockChangedCalls).toEqual([]);
  });

  it('a duplicate-SKU 409 never fires the hook', async () => {
    await createVariant(token, { sku: 'DUPE-1', name: 'First', price: 1000, onHand: 5, fulfillmentType: 'physical' });
    onStockChangedCalls.length = 0;
    const res = await createVariant(token, { sku: 'DUPE-1', name: 'Second', price: 1000, onHand: 5, fulfillmentType: 'physical' });
    expect(res.status).toBe(409);
    expect(onStockChangedCalls).toEqual([]);
  });

  it('PATCH location-stock recomputes the aggregate and fires the hook', async () => {
    await seedPhysicalVariant();
    const res = await locationStock(VARIANT, token, 30);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: VARIANT, onHand: 30 });
    expect(onStockChangedCalls).toEqual([SLUG]);
    const [row] = await withStore(STORE, (tx) => tx.execute(sql`SELECT on_hand FROM stock WHERE variant_id = ${VARIANT}`).then((r) => r.rows as { on_hand: number }[]));
    expect(row!.on_hand).toBe(30);
  });

  it('PATCH location-stock fires again on a second edit (no debounce/coalescing at the route level)', async () => {
    await seedPhysicalVariant();
    await locationStock(VARIANT, token, 10);
    await locationStock(VARIANT, token, 4);
    expect(onStockChangedCalls).toEqual([SLUG, SLUG]);
  });
});
