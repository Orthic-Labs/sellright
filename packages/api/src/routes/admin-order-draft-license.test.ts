/**
 * DB tests for POST /v1/admin/draft-orders with markPaid:true — a manual/phone
 * order for a licensed product must issue licenses exactly like every other
 * Paid transition (checkout settle, gift-card full-cover, Stripe webhook
 * reconcile). Route-level — drives the real Hono handler through app.request()
 * with a seeded owner session, so auth + withStore + RLS all run as in
 * production. Mirrors admin-orders.bulk.test.ts's DB-test scaffolding.
 *
 * Runs against sellright_test ONLY (TRUNCATEs).
 *
 * Covers:
 *   1. draft order + markPaid:true for a licensed variant issues exactly one
 *      license row (quantity 1) with the variant's app_key/seats.
 *   2. a licensed line with quantity > 1 issues one license row per unit.
 *   3. a second issuance call for the same order (as a duplicate webhook/
 *      reconcile would trigger) issues zero more licenses — proves
 *      issueLicensesForPaidOrder's per-orderLine idempotency.
 *   4. markPaid:false issues no licenses (order stays PendingPayment).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { createAdminSession } from '../auth/admin-session.js';
import { admin } from './admin.js';
import { adminOrderOps } from './admin-order-ops.js';
import { issueLicensesForPaidOrder } from '../licensing/issue.js';

// Safety: refuse to run against anything but a *_test database.
const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `draft-order license test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SLUG = 'draft-license-test-store';
const ADMIN = 'eeeeeeee-eeee-eeee-eeee-00000000000a';
const LICENSE_SKU = 'LIC-1';
const LICENSE_SKU_QTY = 'LIC-2';

const app = new OpenAPIHono();
app.route('/', admin);
app.route('/', adminOrderOps);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

/** Seed store + owner admin + session + a licensed product variant (and a
 * second licensed variant for the quantity>1 case). Returns the admin token. */
async function seedStoreAndAdmin(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@draft-license.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    // fulfillmentType 'license' skips stock reservation entirely (physical-only
    // path in reserveStockOrThrow), so no stock row is needed here.
    await tx.execute(sql`
      INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type, app_key, license_seats, license_duration_days, updates_duration_days)
      VALUES (gen_random_uuid(), ${STORE}, ${pid}, ${LICENSE_SKU}, 'Licensed Product', 5000, 'license', 'viewright', 1, NULL, 365)
      ON CONFLICT DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type, app_key, license_seats, license_duration_days, updates_duration_days)
      VALUES (gen_random_uuid(), ${STORE}, ${pid}, ${LICENSE_SKU_QTY}, 'Licensed Product (multi)', 5000, 'license', 'viewright', 1, NULL, 365)
      ON CONFLICT DO NOTHING`);
  });
  return createAdminSession(ADMIN);
}

interface DraftBody { code: string; state: string; grandTotal: number }

async function createDraft(token: string, body: unknown): Promise<{ status: number; body: DraftBody }> {
  const res = await app.request('/v1/admin/draft-orders', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as DraftBody };
}

async function licensesForCode(code: string): Promise<Array<{ id: string; appKey: string; orderLineId: string }>> {
  return withStore(STORE, async (tx) => {
    const [o] = await tx.select({ id: s.order.id }).from(s.order).where(eq(s.order.code, code)).limit(1);
    if (!o) return [];
    const rows = await tx.select({ id: s.license.id, appKey: s.license.appKey, orderLineId: s.license.orderLineId }).from(s.license).where(eq(s.license.orderId, o.id));
    return rows;
  });
}

async function orderRow(code: string): Promise<{ id: string; state: string; customerId: string | null; grandTotal: number } | null> {
  return withStore(STORE, async (tx) => {
    const [o] = await tx.select({ id: s.order.id, state: s.order.state, customerId: s.order.customerId, grandTotal: s.order.grandTotal }).from(s.order).where(eq(s.order.code, code)).limit(1);
    return o ?? null;
  });
}

beforeEach(async () => {
  await wipe();
});
afterEach(wipe);
afterAll(() => pool.end());

describe('draft-orders markPaid issues licenses', () => {
  it('(1) markPaid:true for a licensed product issues exactly one license row', async () => {
    const token = await seedStoreAndAdmin();
    const { status, body } = await createDraft(token, { items: [{ sku: LICENSE_SKU, quantity: 1 }], markPaid: true });
    expect(status).toBe(200);
    expect(body.state).toBe('Paid');

    const licenses = await licensesForCode(body.code);
    expect(licenses).toHaveLength(1);
    expect(licenses[0]!.appKey).toBe('viewright');
  });

  it('(2) a licensed line with quantity 2 issues two license rows (one per seat)', async () => {
    const token = await seedStoreAndAdmin();
    const { status, body } = await createDraft(token, { items: [{ sku: LICENSE_SKU_QTY, quantity: 2 }], markPaid: true });
    expect(status).toBe(200);
    expect(body.state).toBe('Paid');

    const licenses = await licensesForCode(body.code);
    expect(licenses).toHaveLength(2);
    expect(licenses.every((l) => l.appKey === 'viewright')).toBe(true);
  });

  it('(3) a second settlement of the same order issues zero more licenses (per-orderLine idempotency)', async () => {
    const token = await seedStoreAndAdmin();
    const { status, body } = await createDraft(token, { items: [{ sku: LICENSE_SKU, quantity: 1 }], markPaid: true });
    expect(status).toBe(200);
    expect(await licensesForCode(body.code)).toHaveLength(1);

    // Re-run the exact same issuance call a real duplicate webhook/reconcile
    // would trigger for an already-Paid order (issueLicensesForPaidOrder is the
    // single shared function called from both the draft markPaid path and
    // applyPaymentResult's Settled branch — its per-orderLineId shortfall
    // counting must make a repeat call a no-op).
    const order = await orderRow(body.code);
    expect(order).not.toBeNull();
    const issuedAgain = await withStore(STORE, (tx) =>
      issueLicensesForPaidOrder(tx, { storeId: STORE, orderId: order!.id, customerId: order!.customerId, paidAt: new Date() }),
    );
    expect(issuedAgain).toBe(0);

    const licensesAfter = await licensesForCode(body.code);
    expect(licensesAfter).toHaveLength(1); // still exactly one — no double-issue
  });

  it('(4) markPaid:false leaves the order PendingPayment and issues no licenses', async () => {
    const token = await seedStoreAndAdmin();
    const { status, body } = await createDraft(token, { items: [{ sku: LICENSE_SKU, quantity: 1 }], markPaid: false });
    expect(status).toBe(200);
    expect(body.state).toBe('PendingPayment');
    expect(await licensesForCode(body.code)).toHaveLength(0);
  });
});
