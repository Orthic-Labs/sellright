/**
 * DB tests — HARDENING FIX 1: the single-order cancel endpoint
 * (POST /v1/admin/orders/{code}/cancel, admin.ts) must reject a Paid order
 * exactly like the bulk-cancel route already does (admin-order-ops.ts) —
 * cancelling releases stock but never touches money, so a Paid order has to
 * go through Refund instead. Before the fix this route only checked
 * canTransition(state, 'Cancelled'), and the FSM allows Paid->Cancelled (for
 * the state transition that happens AFTER a refund), so a Paid order could be
 * cancelled directly: stock released, order Cancelled, payment left Settled,
 * any issued license left active — the customer keeps the product and a paid
 * refund never happens.
 *
 * Mirrors admin-orders.refund.test.ts / admin-orders.bulk.test.ts conventions:
 * _test-DB guard + TRUNCATE store CASCADE wipe + seed helpers under
 * withStore(). vitest runs files serially (fileParallelism: false).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { admin as adminRoutes } from './admin.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `admin cancel test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SLUG = 'admin-cancel-test-store';
const ADMIN = 'dddddddd-dddd-dddd-dddd-00000000000a';
const VARIANT = 'dddddddd-dddd-dddd-dddd-00000000000b';

const app = new OpenAPIHono();
app.route('/', adminRoutes);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seedStoreAndAdmin(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@cancel.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'V1', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 100, 5) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 100, allocated = 5`);
  });
  return createAdminSession(ADMIN);
}

/** Seed an order in `state` with one unfulfilled line reserving 5 units. */
async function seedOrder(code: string, state: 'PendingPayment' | 'Paid'): Promise<string> {
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, ${state}::order_state, 'USD', 1000)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT}, 'SKU1', 'V1', 5, 1000, 1000, 1000, 0)`);
  });
  if (state === 'Paid') {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`
        INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref)
        VALUES (gen_random_uuid(), ${STORE}, ${orderId}, 1000, 'stripe', 'Settled', ${'pi_' + code})`);
    });
  }
  return orderId;
}

async function orderState(orderId: string): Promise<string> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT state FROM "order" WHERE id = ${orderId}`);
    return (r.rows[0] as { state: string }).state;
  });
}

async function paymentState(orderId: string): Promise<string | null> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT state FROM payment WHERE order_id = ${orderId} LIMIT 1`);
    return (r.rows[0] as { state: string } | undefined)?.state ?? null;
  });
}

async function stockAllocated(): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT allocated FROM stock WHERE variant_id = ${VARIANT}`);
    return (r.rows[0] as { allocated: number }).allocated;
  });
}

async function cancelOrder(code: string): Promise<{ status: number; body: unknown }> {
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
  token = await seedStoreAndAdmin();
});
afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('POST /v1/admin/orders/{code}/cancel — HARDENING FIX 1', () => {
  it('rejects cancelling a Paid order (409) — money and licenses must go through Refund instead', async () => {
    const orderId = await seedOrder('SR-CANCEL-PAID-1', 'Paid');

    const res = await cancelOrder('SR-CANCEL-PAID-1');

    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/paid order.*use Refund/i);
    // Nothing changed: order still Paid, payment still Settled, stock untouched.
    expect(await orderState(orderId)).toBe('Paid');
    expect(await paymentState(orderId)).toBe('Settled');
    expect(await stockAllocated()).toBe(5);
  });

  it('still allows cancelling a PendingPayment order and releases its stock', async () => {
    const orderId = await seedOrder('SR-CANCEL-UNPAID-1', 'PendingPayment');

    const res = await cancelOrder('SR-CANCEL-UNPAID-1');

    expect(res.status).toBe(200);
    expect(await orderState(orderId)).toBe('Cancelled');
    expect(await stockAllocated()).toBe(0); // released
  });
});
