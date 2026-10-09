/**
 * Settlement review F1 (P0): an admin draft created UNPAID must not consume the order's Paid-transition
 * operation key. Drives the real draft route (app.request) and then a real settlement; the order must still
 * transition to Paid with its licence and fan-out. Also: a replayed operation whose order_paid was never
 * applied is refused, never reported as settled. Runs against a *_test database only (truncates).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { applyPaymentResult } from '../payments/settle.js';
import { recordSettlementOperation } from '../payments/settlement/record.js';
import { admin } from './admin.js';
import { adminOrderOps } from './admin-order-ops.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`draft settlement test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'f1f1f1f1-0000-0000-0000-000000000001';
const SLUG = 'f1-draft-store';
const ADMIN = 'f1f1f1f1-0000-0000-0000-00000000000a';
const VARIANT = 'f1f1f1f1-0000-0000-0000-00000000000b';
const SKU = 'F1-PLAN';

const app = new OpenAPIHono();
app.route('/', admin);
app.route('/', adminOrderOps);

let token = '';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed() {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, 'F1', 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@f1.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    const prod = await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'f1-plan', 'Plan', 'active') RETURNING id`);
    const productId = (prod.rows[0] as { id: string }).id;
    await tx.execute(sql`
      INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type, app_key, license_duration_days, updates_duration_days, stripe_price_id, billing_interval)
      VALUES (${VARIANT}, ${STORE}, ${productId}, ${SKU}, 'Plan', 1000, 'license', 'testapp', 30, 30, 'price_f1', 'month') ON CONFLICT (id) DO NOTHING`);
  });
  token = await createAdminSession(ADMIN);
}

async function draft(markPaid: boolean): Promise<{ code: string; state: string; grandTotal: number }> {
  const res = await app.request('/v1/admin/draft-orders', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], email: 'buyer@f1.test', markPaid }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { code: string; state: string; grandTotal: number };
}

beforeEach(async () => { await wipe(); await seed(); });
afterAll(async () => { await wipe(); });

describe('F1: admin draft orders and the Paid-transition operation key', () => {
  it('an unpaid draft settled later becomes Paid, issues its licence, and runs loyalty + notification', async () => {
    const d = await draft(false);
    expect(d.state).toBe('PendingPayment');
    const order = await withStore(STORE, async (tx) => (await tx.select().from(s.order).where(eq(s.order.code, d.code)))[0]!);

    // the draft records no Paid-transition operation (the key stays free for the real settlement)
    const before = await withStore(STORE, (tx) => tx.select().from(s.settlementOperation).where(eq(s.settlementOperation.orderId, order.id)));
    expect(before.some((o) => o.operationKind === 'order_paid_transition')).toBe(false);

    await withStore(STORE, (tx) => applyPaymentResult(tx, {
      storeId: STORE,
      order: { id: order.id, state: order.state, grandTotal: order.grandTotal, currency: order.currency, customerId: order.customerId, code: order.code },
      method: 'stripe',
      result: { state: 'Settled', providerRef: 'pi_f1_draft', metadata: null },
    }));

    const after = await withStore(STORE, async (tx) => (await tx.select().from(s.order).where(eq(s.order.id, order.id)))[0]!);
    expect(after.state).toBe('Paid');
    const licences = await withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, order.id)));
    expect(licences.length).toBe(1);
    const effects = await withStore(STORE, (tx) => tx.select().from(s.orderPendingEffect).where(eq(s.orderPendingEffect.operationId, order.id)));
    expect(Object.fromEntries(effects.map((e) => [e.effectKind, e.status]))).toEqual({
      license_issue: 'done', loyalty_earn: 'done', notification: 'done',
    });
  });

  it('a paid draft is licensed once and records its Paid transition under the order key', async () => {
    const d = await draft(true);
    expect(d.state).toBe('Paid');
    const order = await withStore(STORE, async (tx) => (await tx.select().from(s.order).where(eq(s.order.code, d.code)))[0]!);
    const ops = await withStore(STORE, (tx) => tx.select().from(s.settlementOperation).where(eq(s.settlementOperation.orderId, order.id)));
    expect(ops.map((o) => o.operationKind).sort()).toEqual(['order_paid_transition']);
    const licences = await withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, order.id)));
    expect(licences.length).toBe(1);
  });

  it('a replay whose order_paid was never applied is refused, not reported as settled', async () => {
    const d = await draft(false);
    const order = await withStore(STORE, async (tx) => (await tx.select().from(s.order).where(eq(s.order.code, d.code)))[0]!);
    // the operation row exists without its mutation (the order is still payable)
    await withStore(STORE, (tx) => recordSettlementOperation(tx, {
      storeId: STORE, kind: 'order_paid_transition', operationId: order.id, orderId: order.id, mutations: [], effects: [],
    }));
    await expect(withStore(STORE, (tx) => recordSettlementOperation(tx, {
      storeId: STORE, kind: 'order_paid_transition', operationId: order.id, orderId: order.id,
      mutations: [{ type: 'order_paid', orderId: order.id, placedAt: new Date() }], effects: [],
    }))).rejects.toThrow(/unapplied order_paid/);
    const still = await withStore(STORE, async (tx) => (await tx.select().from(s.order).where(eq(s.order.id, order.id)))[0]!);
    expect(still.state).toBe('PendingPayment');
  });
});
