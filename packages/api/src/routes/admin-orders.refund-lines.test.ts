/**
 * DB tests — admin-essentials refund additions on top of the existing
 * per-line/idempotency machinery (admin-orders.refund.test.ts covers that):
 *   1. per-line restock — a single refund request can restock SOME lines and
 *      not others (line-level `restock` wins over the top-level default).
 *   2. a separate `shippingAmount`, added on top of the per-line items total,
 *      stored on its own refund.shipping_amount column (not folded into the
 *      opaque adjustment bucket).
 *
 * Uses the 'manual' payment method (refundPayment settles instantly, no
 * gateway/mode plumbing needed) to keep these tests focused on the ledger
 * effects rather than gateway mocking (already covered elsewhere).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminOrders } from './admin-orders.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`refund-lines test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'cccccccc-3333-3333-3333-333333333333';
const SLUG = 'refund-lines-test-store';
const ADMIN = 'cccccccc-3333-3333-3333-00000000000a';
const VARIANT_A = 'cccccccc-3333-3333-3333-00000000000b';
const VARIANT_B = 'cccccccc-3333-3333-3333-00000000000c';

const app = new OpenAPIHono();
app.route('/', adminOrders);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@refund-lines.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT_A}, ${STORE}, ${pid}, 'SKU-A', 'Variant A', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT_B}, ${STORE}, ${pid}, 'SKU-B', 'Variant B', 500) ON CONFLICT (id) DO NOTHING`);
    // Both variants already shipped (on_hand reflects the earlier fulfillment) — needed to observe restock actually restoring on_hand.
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT_A}, ${STORE}, 3, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 3, allocated = 0`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT_B}, ${STORE}, 4, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 4, allocated = 0`);
  });
  return createAdminSession(ADMIN);
}

/** A fully-fulfilled Paid order: line A (qty 2 @ 1000 = 2000), line B (qty 1 @ 500 = 500), manual payment for 2500. */
async function seedFulfilledOrder(code: string): Promise<{ orderId: string; lineA: string; lineB: string }> {
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, 'Paid'::order_state, 'USD', 2500)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  const lineA = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT_A}, 'SKU-A', 'Variant A', 2, 1000, 2000, 2000, 2)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  const lineB = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT_B}, 'SKU-B', 'Variant B', 1, 500, 500, 500, 1)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO payment (id, store_id, order_id, amount, method, state) VALUES (gen_random_uuid(), ${STORE}, ${orderId}, 2500, 'manual', 'Settled')`);
  });
  return { orderId, lineA, lineB };
}

async function refundOrder(code: string, body: Record<string, unknown>) {
  const res = await app.request(`/v1/admin/orders/${code}/refund`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: 'rl-' + code, ...body }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function stockOnHand(variantId: string): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT on_hand FROM stock WHERE variant_id = ${variantId}`);
    return (r.rows[0] as { on_hand: number }).on_hand;
  });
}

let token = '';
beforeEach(async () => { await wipe(); token = await seed(); });
afterAll(async () => { await wipe(); await pool.end(); });

describe('per-line restock', () => {
  it('restocks only the line(s) flagged restock:true, leaving the other line NOT restocked', async () => {
    const { orderId, lineA, lineB } = await seedFulfilledOrder('RL-1');
    const res = await refundOrder('RL-1', {
      lines: [
        { orderLineId: lineA, quantity: 2, restock: true },
        { orderLineId: lineB, quantity: 1, restock: false },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refunded: 2500, state: 'Refunded' });

    expect(await stockOnHand(VARIANT_A)).toBe(5); // 3 + 2 restocked
    expect(await stockOnHand(VARIANT_B)).toBe(4); // unchanged — not restocked

    const restockFlags = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT order_line_id, restock FROM refund_line WHERE refund_id = (SELECT id FROM refund WHERE order_id = ${orderId})`);
      return r.rows as { order_line_id: string; restock: boolean }[];
    });
    expect(restockFlags.find((r) => r.order_line_id === lineA)?.restock).toBe(true);
    expect(restockFlags.find((r) => r.order_line_id === lineB)?.restock).toBe(false);
  });

  it('a line-level restock overrides the top-level default', async () => {
    const { lineA } = await seedFulfilledOrder('RL-2');
    // Top-level restock defaults to false; the line explicitly opts in.
    const res = await refundOrder('RL-2', { lines: [{ orderLineId: lineA, quantity: 2, restock: true }] });
    expect(res.status).toBe(200);
    expect(await stockOnHand(VARIANT_A)).toBe(5);
  });
});

describe('separate shippingAmount', () => {
  it('adds shippingAmount on top of the per-line items total and stores it on its own column', async () => {
    const { orderId, lineA } = await seedFulfilledOrder('RL-3');
    // Bump the order total so a 2000 (items) + 300 (shipping) = 2300 refund fits under the payment balance.
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE payment SET amount = 2300 WHERE order_id = ${orderId}`));
    const res = await refundOrder('RL-3', {
      lines: [{ orderLineId: lineA, quantity: 2, restock: false }],
      shippingAmount: 300,
      reason: 'goodwill shipping refund',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refunded: 2300 });

    const row = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT amount, items_amount, shipping_amount, reason FROM refund WHERE order_id = ${orderId}`);
      return r.rows[0] as { amount: number; items_amount: number; shipping_amount: number; reason: string };
    });
    expect(row).toMatchObject({ amount: 2300, items_amount: 2000, shipping_amount: 300, reason: 'goodwill shipping refund' });
  });

  it('ignores shippingAmount when no explicit lines are given (full-remaining refund is already the whole balance)', async () => {
    const { orderId } = await seedFulfilledOrder('RL-4');
    const res = await refundOrder('RL-4', { shippingAmount: 999999 }); // would exceed the balance if it were added
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refunded: 2500 }); // full remaining balance, not balance + shippingAmount
    void orderId;
  });
});
