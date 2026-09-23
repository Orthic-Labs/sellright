/**
 * DB test — zero-cache stock rule: routes/admin.ts's single-order fulfill,
 * bulk-fulfill, and single-order cancel all mutate `stock.on_hand`/`allocated`
 * directly (outside orders/stock-reservation.ts) and must trigger an
 * immediate catalog-manifest regeneration (manifest/stock-hook.js) right
 * after their own transaction commits — never on a repeat/no-op call that
 * touches no stock row.
 *
 * Mirrors routes/admin-orders.cancel.test.ts / admin-products.stock.test.ts
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
import { admin as adminRoutes } from './admin.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`admin stock-hook test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'aaaa1111-1111-1111-1111-111111111111';
const SLUG = 'admin-stock-hook-test-store';
const ADMIN = 'aaaa1111-1111-1111-1111-00000000000a';
const VARIANT = 'aaaa1111-1111-1111-1111-00000000000b';

const app = new OpenAPIHono();
app.route('/', adminRoutes);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seedStoreAdminAndVariant(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@admin-stock-hook.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'V1', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 100, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 100, allocated = 0`);
  });
  return createAdminSession(ADMIN);
}

/** A Paid order with one physical line reserving `qty` units (allocated bumped
 *  to match), so fulfill/cancel have real stock to move. */
async function seedPaidOrder(code: string, qty: number): Promise<string> {
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, 'Paid'::order_state, 'USD', 1000)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT}, 'SKU1', 'V1', ${qty}, 1000, 1000, 1000, 0)`);
    await tx.execute(sql`UPDATE stock SET allocated = allocated + ${qty} WHERE variant_id = ${VARIANT}`);
  });
  return orderId;
}

async function seedPendingOrder(code: string, qty: number): Promise<string> {
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, 'PendingPayment'::order_state, 'USD', 1000)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT}, 'SKU1', 'V1', ${qty}, 1000, 1000, 1000, 0)`);
    await tx.execute(sql`UPDATE stock SET allocated = allocated + ${qty} WHERE variant_id = ${VARIANT}`);
  });
  return orderId;
}

async function fulfill(code: string, token: string, state: 'Shipped' | 'Delivered' = 'Shipped') {
  const res = await app.request(`/v1/admin/orders/${code}/fulfill`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  return { status: res.status, body: await res.json() };
}

async function bulkFulfill(codes: string[], token: string) {
  const res = await app.request('/v1/admin/orders/bulk-fulfill', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify({ orders: codes.map((code) => ({ code, state: 'Shipped' as const })) }),
  });
  return { status: res.status, body: await res.json() };
}

async function cancel(code: string, token: string) {
  const res = await app.request(`/v1/admin/orders/${code}/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify({}),
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

describe('routes/admin.ts — zero-cache stock hook wiring', () => {
  it('single fulfill: transitioning into Shipped consumes stock and fires the hook once', async () => {
    const orderId = await seedPaidOrder('SR-ADM-FULFILL-1', 3);
    const res = await fulfill('SR-ADM-FULFILL-1', token, 'Shipped');
    expect(res.status).toBe(200);
    expect(onStockChangedCalls).toEqual([SLUG]);
    const [row] = await withStore(STORE, (tx) => tx.execute(sql`SELECT on_hand, allocated FROM stock WHERE variant_id = ${VARIANT}`).then((r) => r.rows as { on_hand: number; allocated: number }[]));
    expect(row).toMatchObject({ on_hand: 97, allocated: 0 });
    void orderId;
  });

  it('single fulfill: a repeat Shipped call (tracking-only refresh) touches no stock row and does not re-fire the hook', async () => {
    await seedPaidOrder('SR-ADM-FULFILL-2', 3);
    await fulfill('SR-ADM-FULFILL-2', token, 'Shipped');
    onStockChangedCalls.length = 0; // clear the first call's signal
    const res = await fulfill('SR-ADM-FULFILL-2', token, 'Shipped');
    expect(res.status).toBe(200);
    expect(onStockChangedCalls).toEqual([]);
  });

  it('single fulfill: a badstate 409 (order not Paid) never touches stock or fires the hook', async () => {
    await seedPendingOrder('SR-ADM-FULFILL-3', 3);
    const res = await fulfill('SR-ADM-FULFILL-3', token, 'Shipped');
    expect(res.status).toBe(409);
    expect(onStockChangedCalls).toEqual([]);
  });

  it('bulk-fulfill: each order that actually ships fires its own hook call', async () => {
    await seedPaidOrder('SR-ADM-BULK-1', 2);
    await seedPaidOrder('SR-ADM-BULK-2', 2);
    const res = await bulkFulfill(['SR-ADM-BULK-1', 'SR-ADM-BULK-2'], token);
    expect(res.status).toBe(200);
    expect(onStockChangedCalls).toEqual([SLUG, SLUG]);
  });

  it('bulk-fulfill: a not-found code in the batch never fires the hook for that row', async () => {
    await seedPaidOrder('SR-ADM-BULK-3', 2);
    const res = await bulkFulfill(['SR-ADM-BULK-3', 'SR-ADM-BULK-MISSING'], token);
    expect(res.status).toBe(200);
    expect(onStockChangedCalls).toEqual([SLUG]); // only the real order fired it
  });

  it('cancel: releasing reserved allocation on a PendingPayment order fires the hook once', async () => {
    await seedPendingOrder('SR-ADM-CANCEL-1', 4);
    const res = await cancel('SR-ADM-CANCEL-1', token);
    expect(res.status).toBe(200);
    expect(onStockChangedCalls).toEqual([SLUG]);
    const [row] = await withStore(STORE, (tx) => tx.execute(sql`SELECT allocated FROM stock WHERE variant_id = ${VARIANT}`).then((r) => r.rows as { allocated: number }[]));
    expect(row!.allocated).toBe(0);
  });

  it('cancel: a Paid order is rejected (409, use Refund) and never fires the hook', async () => {
    await seedPaidOrder('SR-ADM-CANCEL-2', 4);
    const res = await cancel('SR-ADM-CANCEL-2', token);
    expect(res.status).toBe(409);
    expect(onStockChangedCalls).toEqual([]);
  });
});
