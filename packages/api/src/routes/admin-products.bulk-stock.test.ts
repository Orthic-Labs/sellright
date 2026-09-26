/**
 * DB test — PATCH /v1/admin/variants/stock/bulk (gap: multi-select bulk stock
 * edit). Mirrors admin-products.stock.test.ts (single-variant stock hook
 * wiring) but for the batch endpoint:
 *   1. updates on_hand for every variant in one transaction, one audit_log
 *      row per variant, one stockMovement row per changed variant
 *   2. fires onStockChanged exactly ONCE for the whole batch, not once per
 *      variant (zero-cache rule, but no redundant regen storms)
 *   3. atomic: an unknown variant id aborts the WHOLE batch — nothing is
 *      written for the valid ids either, and the hook does not fire
 *   4. requires an authenticated write-capable session
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
  throw new Error(`bulk-stock test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-2222-2222-2222-222222222222';
const SLUG = 'bulk-stock-test-store';
const ADMIN = 'eeeeeeee-2222-2222-2222-00000000000a';
const V1 = 'eeeeeeee-2222-2222-2222-00000000000b';
const V2 = 'eeeeeeee-2222-2222-2222-00000000000c';
const V3_NO_STOCK_ROW_YET = 'eeeeeeee-2222-2222-2222-00000000000d';
const UNKNOWN_VARIANT = 'eeeeeeee-2222-2222-2222-000000000fff';

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
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@bulk-stock.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${V1}, ${STORE}, ${pid}, 'SKU1', 'V1', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${V2}, ${STORE}, ${pid}, 'SKU2', 'V2', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${V3_NO_STOCK_ROW_YET}, ${STORE}, ${pid}, 'SKU3', 'V3', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${V1}, ${STORE}, 10, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 10, allocated = 0`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${V2}, ${STORE}, 20, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 20, allocated = 0`);
    // V3 deliberately has NO stock row yet — bulk endpoint must insert one, like the single PATCH does.
  });
  return createAdminSession(ADMIN);
}

type BulkStockBody = { updated: { id: string; onHand: number }[] } | { error: string; missing?: string[] };

async function patchBulk(items: { id: string; onHand: number }[], token: string): Promise<{ status: number; body: BulkStockBody }> {
  const res = await app.request('/v1/admin/variants/stock/bulk', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  return { status: res.status, body: (await res.json()) as BulkStockBody };
}

async function stockRow(variantId: string): Promise<{ onHand: number } | null> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT on_hand FROM stock WHERE variant_id = ${variantId} LIMIT 1`);
    const row = r.rows[0] as { on_hand: number } | undefined;
    return row ? { onHand: row.on_hand } : null;
  });
}

async function movementCount(variantId: string): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT count(*)::int n FROM stock_movement WHERE variant_id = ${variantId} AND reason = 'admin_bulk_adjust'`);
    return (r.rows[0] as { n: number }).n;
  });
}

async function auditCount(variantId: string): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT count(*)::int n FROM audit_log WHERE entity_id = ${variantId} AND action = 'stock'`);
    return (r.rows[0] as { n: number }).n;
  });
}

let token = '';
beforeEach(async () => {
  await wipe();
  onStockChangedCalls.length = 0;
  token = await seed();
});
afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('PATCH /v1/admin/variants/stock/bulk', () => {
  it('updates every variant in one call, inserting a stock row for a variant that had none', async () => {
    const { status, body } = await patchBulk(
      [{ id: V1, onHand: 5 }, { id: V2, onHand: 50 }, { id: V3_NO_STOCK_ROW_YET, onHand: 7 }],
      token,
    );
    expect(status).toBe(200);
    if (!('updated' in body)) throw new Error(`expected success body, got: ${JSON.stringify(body)}`);
    expect(body.updated).toEqual(expect.arrayContaining([
      { id: V1, onHand: 5 }, { id: V2, onHand: 50 }, { id: V3_NO_STOCK_ROW_YET, onHand: 7 },
    ]));
    expect(await stockRow(V1)).toEqual({ onHand: 5 });
    expect(await stockRow(V2)).toEqual({ onHand: 50 });
    expect(await stockRow(V3_NO_STOCK_ROW_YET)).toEqual({ onHand: 7 });

    expect(await movementCount(V1)).toBe(1); // 10 -> 5
    expect(await movementCount(V2)).toBe(1); // 20 -> 50
    expect(await movementCount(V3_NO_STOCK_ROW_YET)).toBe(1); // new row, delta = onHand
    expect(await auditCount(V1)).toBe(1);
    expect(await auditCount(V2)).toBe(1);
    expect(await auditCount(V3_NO_STOCK_ROW_YET)).toBe(1);
  });

  it('fires onStockChanged exactly once for the whole batch, not once per variant', async () => {
    await patchBulk([{ id: V1, onHand: 1 }, { id: V2, onHand: 2 }], token);
    expect(onStockChangedCalls).toEqual([SLUG]);
  });

  it('is atomic: an unknown variant id aborts the WHOLE batch, including the valid rows', async () => {
    const { status, body } = await patchBulk(
      [{ id: V1, onHand: 999 }, { id: UNKNOWN_VARIANT, onHand: 1 }],
      token,
    );
    expect(status).toBe(404);
    if (!('error' in body)) throw new Error(`expected error body, got: ${JSON.stringify(body)}`);
    expect(body.error).toMatch(new RegExp(UNKNOWN_VARIANT));
    // V1 must be untouched — nothing partially applied.
    expect(await stockRow(V1)).toEqual({ onHand: 10 });
    expect(await movementCount(V1)).toBe(0);
    expect(onStockChangedCalls).toEqual([]);
  });

  it('requires admin auth', async () => {
    const res = await app.request('/v1/admin/variants/stock/bulk', {
      method: 'PATCH',
      headers: { 'x-store-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: V1, onHand: 1 }] }),
    });
    expect(res.status).toBe(401);
    expect(onStockChangedCalls).toEqual([]);
  });
});
