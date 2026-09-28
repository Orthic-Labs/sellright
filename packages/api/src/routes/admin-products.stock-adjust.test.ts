/**
 * DB tests — admin-essentials stock adjustments:
 * POST /v1/admin/variants/{id}/stock/adjust (signed delta + mandatory reason,
 * append-only — never an overwrite) and GET .../stock/history (the ledger a
 * merchant reads back). Distinct from PATCH /variants/{id}/stock (absolute
 * on-hand set, unchanged, still used by the inline/bulk editors).
 *
 * Mirrors admin-products.stock.test.ts conventions: _test-DB guard +
 * TRUNCATE store CASCADE wipe + createAdminSession() + real app.request().
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminProducts } from './admin-products.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`stock-adjust test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'dddddddd-2222-2222-2222-222222222222';
const SLUG = 'stock-adjust-test-store';
const ADMIN = 'dddddddd-2222-2222-2222-00000000000a';
const VARIANT = 'dddddddd-2222-2222-2222-00000000000b';
const NEW_VARIANT = 'dddddddd-2222-2222-2222-00000000000c'; // no stock row yet

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
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@stock-adjust.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'V1', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${NEW_VARIANT}, ${STORE}, ${pid}, 'SKU2', 'V2', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 10, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 10, allocated = 0`);
  });
  return createAdminSession(ADMIN);
}

async function adjust(id: string, body: Record<string, unknown>) {
  const res = await app.request(`/v1/admin/variants/${id}/stock/adjust`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function history(id: string) {
  const res = await app.request(`/v1/admin/variants/${id}/stock/history`, {
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG },
  });
  return { status: res.status, body: await res.json() as { items: Array<{ delta: number; reason: string; actor: string | null }>; total: number } };
}

let token = '';
beforeEach(async () => { await wipe(); token = await seed(); });
afterAll(async () => { await wipe(); await pool.end(); });

describe('POST /v1/admin/variants/{id}/stock/adjust', () => {
  it('applies a positive delta and records the reason + acting admin', async () => {
    const res = await adjust(VARIANT, { delta: 5, reason: 'cycle count correction' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: VARIANT, onHand: 15 });

    const h = await history(VARIANT);
    expect(h.body.items[0]).toMatchObject({ delta: 5, reason: 'cycle count correction', actor: 'owner@stock-adjust.test' });
  });

  it('applies a negative delta', async () => {
    const res = await adjust(VARIANT, { delta: -3, reason: 'damaged in warehouse' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: VARIANT, onHand: 7 });
  });

  it('rejects a delta that would take on-hand negative — no row is written', async () => {
    const res = await adjust(VARIANT, { delta: -100, reason: 'oops' });
    expect(res.status).toBe(409);
    const h = await history(VARIANT);
    expect(h.body.total).toBe(0);
  });

  it('rejects a zero delta', async () => {
    const res = await adjust(VARIANT, { delta: 0, reason: 'no-op' });
    expect(res.status).toBe(400);
  });

  it('rejects a blank reason', async () => {
    const res = await adjust(VARIANT, { delta: 1, reason: '' });
    expect(res.status).toBe(400);
  });

  it('creates the stock row for a variant with none yet (positive delta only)', async () => {
    const res = await adjust(NEW_VARIANT, { delta: 8, reason: 'initial count' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: NEW_VARIANT, onHand: 8 });
  });

  it('rejects a negative delta for a variant with no stock row (would go negative)', async () => {
    const res = await adjust(NEW_VARIANT, { delta: -1, reason: 'oops' });
    expect(res.status).toBe(409);
  });

  it('404s for an unknown variant', async () => {
    const res = await adjust('00000000-0000-0000-0000-000000000000', { delta: 1, reason: 'x' });
    expect(res.status).toBe(404);
  });

  it('never overwrites — every adjustment is an additional ledger row, oldest last, never a mutation of a prior row', async () => {
    await adjust(VARIANT, { delta: 2, reason: 'first' });
    await adjust(VARIANT, { delta: -1, reason: 'second' });
    const h = await history(VARIANT);
    expect(h.body.total).toBe(2);
    expect(h.body.items.map((i) => i.reason)).toEqual(['second', 'first']); // newest first
    expect(h.body.items.map((i) => i.delta)).toEqual([-1, 2]);
  });
});
