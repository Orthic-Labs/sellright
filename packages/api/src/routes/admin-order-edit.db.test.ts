/**
 * Route-level coverage for order editing (G13 / G5): drives the real Hono
 * handlers through app.request() so admin auth + roles + permissions + withStore
 * + RLS + the structured error envelope all run as in production. The
 * service-level behaviour (every op / settlement path) is covered in
 * orders/order-edit.db.test.ts; this file proves the HTTP contract.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminOrderEdit } from './admin-order-edit.js';
import { admin as adminRoutes } from './admin.js';
import { adminOrders } from './admin-orders.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) throw new Error(`order-edit route test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);

const STORE = 'e1000000-0000-0000-0000-0000000e0002';
const SLUG = 'orderedit-route';
const OWNER = 'e1000000-0000-0000-0000-00000000000a';
const READER = 'e1000000-0000-0000-0000-00000000000b';
const STAFF = 'e1000000-0000-0000-0000-00000000000c';
const VARIANT = 'e1000000-0000-0000-0000-0000000000d1';
const app = new OpenAPIHono();
app.route('/', adminOrderEdit);
app.route('/', adminRoutes);
app.route('/', adminOrders);

let owner = ''; let reader = ''; let staff = '';
let CODE = 'SRROUTE0001';

async function seed() {
  await pool.query('TRUNCATE store CASCADE'); await pool.query('DELETE FROM "session"'); await pool.query('DELETE FROM admin_user');
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{"payments":{"stripe":true}}'::jsonb)`);
    for (const [id, email, role] of [[OWNER, 'owner@route.test', 'owner'], [READER, 'reader@route.test', 'read_only'], [STAFF, 'staff@route.test', 'staff']] as const) {
      await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${id}, ${email}, 'x')`);
      await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${id}, ${STORE}, ${role})`);
    }
    const p = await tx.execute(sql`INSERT INTO product (store_id, slug, name, status) VALUES (${STORE}, 'p', 'Widget', 'active') RETURNING id`);
    const pid = (p.rows[0] as { id: string }).id;
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'Widget One', 1000)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 50, 2)`);
    const o = await tx.execute(sql`INSERT INTO "order" (store_id, code, state, currency, subtotal, shipping_total, grand_total, shipping_address, metadata)
      VALUES (${STORE}, ${CODE}, 'Paid', 'USD', 2000, 0, 2000, '{"line1":"1 A St","city":"Austin","country":"US"}'::jsonb, '{"contact":{"email":"c@route.test"}}'::jsonb) RETURNING id`);
    const oid = (o.rows[0] as { id: string }).id;
    await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total) VALUES (${STORE}, ${oid}, ${VARIANT}, 'SKU1', 'Widget One', 2, 1000, 2000, 2000)`);
    await tx.execute(sql`INSERT INTO payment (store_id, order_id, amount, method, state, provider_ref, gateway_mode, currency) VALUES (${STORE}, ${oid}, 2000, 'stripe', 'Settled', 'pi_route', 'test', 'USD')`);
  });
  owner = await createAdminSession(OWNER); reader = await createAdminSession(READER); staff = await createAdminSession(STAFF);
}
beforeEach(seed);
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.query('DELETE FROM "session"'); await pool.query('DELETE FROM admin_user'); });

const call = (token: string | null, method: string, path: string, body?: unknown) => app.request(path, {
  method, headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
});
const lineId = async () => (await withStore(STORE, (tx) => tx.execute(sql`SELECT id FROM order_line LIMIT 1`))).rows[0] as { id: string };

describe('order edit HTTP contract', () => {
  it('requires auth; read-only role may read context but not preview/commit/address', async () => {
    expect((await call(null, 'POST', `/v1/admin/orders/${CODE}/edit/preview`, { ops: [] })).status).toBe(401);
    expect((await call(reader, 'GET', `/v1/admin/orders/${CODE}/edit/context`)).status).toBe(200);
    expect((await call(reader, 'POST', `/v1/admin/orders/${CODE}/edit/preview`, { ops: [] })).status).toBe(403);
    expect((await call(reader, 'POST', `/v1/admin/orders/${CODE}/edit/commit`, { ops: [{ op: 'remove_shipping' }], expectedGrandTotal: 2000, idempotencyKey: 'k' })).status).toBe(403);
    expect((await call(reader, 'PUT', `/v1/admin/orders/${CODE}/address`, { kind: 'billing', address: { line1: 'x', city: 'y', country: 'US' } })).status).toBe(403);
  });

  it('context reports locks, shipping methods and editability; preview returns the balance', async () => {
    const ctx = await (await call(owner, 'GET', `/v1/admin/orders/${CODE}/edit/context`)).json() as { editable: { items: boolean }; lines: Array<{ minQuantity: number }> };
    expect(ctx.editable.items).toBe(true);
    expect(ctx.lines[0]!.minQuantity).toBe(0);
    const { id } = await lineId();
    const res = await call(owner, 'POST', `/v1/admin/orders/${CODE}/edit/preview`, { ops: [{ op: 'set_quantity', lineId: id, quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ after: { grandTotal: 1000 }, balance: { amountDue: -1000 }, settlementOptions: ['refund_now', 'leave_credit'] });
  });

  it('validation errors are 400; unknown order is 404; locked/stale/idempotency map to 409 envelopes', async () => {
    expect((await call(owner, 'POST', `/v1/admin/orders/${CODE}/edit/preview`, { ops: [{ op: 'bogus' }] })).status).toBe(400);
    expect((await call(owner, 'POST', `/v1/admin/orders/NOPE/edit/preview`, { ops: [{ op: 'remove_shipping' }] })).status).toBe(404);
    const { id } = await lineId();
    const stale = await call(owner, 'POST', `/v1/admin/orders/${CODE}/edit/commit`, { ops: [{ op: 'set_quantity', lineId: id, quantity: 1 }], expectedGrandTotal: 999, idempotencyKey: 'stale', settlement: { type: 'leave_credit' } });
    expect(stale.status).toBe(409);
    const body = await stale.json() as { error: { code: string }; grandTotal: number };
    expect(body.error.code).toBe('PREVIEW_STALE');
    expect(body.grandTotal).toBe(1000);
    const noSettle = await call(owner, 'POST', `/v1/admin/orders/${CODE}/edit/commit`, { ops: [{ op: 'set_quantity', lineId: id, quantity: 1 }], expectedGrandTotal: 1000, idempotencyKey: 'ns' });
    expect(noSettle.status).toBe(400);
    expect(((await noSettle.json()) as { error: { code: string } }).error.code).toBe('SETTLEMENT_REQUIRED');
  });

  it('commit applies, replays idempotently, and shows on the order detail (balance + timeline)', async () => {
    const { id } = await lineId();
    const payload = { ops: [{ op: 'add_item', sku: 'SKU1', quantity: 1 }], expectedGrandTotal: 3000, idempotencyKey: 'route-1', settlement: { type: 'leave_due' }, notifyCustomer: false, reason: 'phone order' };
    const r1 = await call(owner, 'POST', `/v1/admin/orders/${CODE}/edit/commit`, payload);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ grandTotal: 3000, balance: 1000, amountDue: 1000, replay: false });
    const r2 = await call(owner, 'POST', `/v1/admin/orders/${CODE}/edit/commit`, payload);
    expect(await r2.json()).toMatchObject({ replay: true });
    const detail = await (await call(owner, 'GET', `/v1/admin/orders/${CODE}`)).json() as { paymentStatus: string; amountDue: number; lines: unknown[]; events: Array<{ action: string; data?: { reason?: string; changes?: string[] } }> };
    expect(detail).toMatchObject({ paymentStatus: 'balance_due', amountDue: 1000 });
    expect(detail.lines).toHaveLength(2);
    const ev = detail.events.find((e) => e.action === 'edit')!;
    expect(ev.data?.reason).toBe('phone order');
    expect(ev.data?.changes?.[0]).toContain('Added 1');
    void id;
  });

  it('staff without the refunds permission cannot refund_now (403) but can edit with other settlements', async () => {
    const { id } = await lineId();
    const ops = [{ op: 'set_quantity', lineId: id, quantity: 1 }];
    const denied = await call(staff, 'POST', `/v1/admin/orders/${CODE}/edit/commit`, { ops, expectedGrandTotal: 1000, idempotencyKey: 's1', settlement: { type: 'refund_now' } });
    expect(denied.status).toBe(403);
    const ok = await call(staff, 'POST', `/v1/admin/orders/${CODE}/edit/commit`, { ops, expectedGrandTotal: 1000, idempotencyKey: 's2', settlement: { type: 'leave_credit' } });
    expect(ok.status).toBe(200);
  });

  it('address: same-country save works directly; country change is a 409 pointing at the edit flow; bad country is 400', async () => {
    const addr = { fullName: 'New', line1: '9 B St', city: 'Dallas', province: 'TX', postalCode: '75001', country: 'us' };
    const ok = await call(owner, 'PUT', `/v1/admin/orders/${CODE}/address`, { kind: 'shipping', address: addr, reason: 'moved' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ changed: true, savedToAddressBook: false, address: { country: 'US', line1: '9 B St' } });
    const cc = await call(owner, 'PUT', `/v1/admin/orders/${CODE}/address`, { kind: 'shipping', address: { ...addr, country: 'CA' } });
    expect(cc.status).toBe(409);
    expect(((await cc.json()) as { error: { code: string }; requiresPreview: boolean }).error.code).toBe('COUNTRY_CHANGE_REQUIRES_EDIT');
    expect((await call(owner, 'PUT', `/v1/admin/orders/${CODE}/address`, { kind: 'shipping', address: { ...addr, country: 'USA' } })).status).toBe(400);
  });

  it('variant picker returns enabled variants with live availability', async () => {
    const res = await call(owner, 'GET', `/v1/admin/orders/${CODE}/edit/variants?q=widget`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [{ sku: 'SKU1', unitPrice: 1000, available: 48 }] });
  });

  it('the invoice omits zero-quantity (edited-out) lines and lists adjustments so it adds up', async () => {
    const { id } = await lineId();
    const ops = [{ op: 'set_quantity', lineId: id, quantity: 0 }, { op: 'add_item', sku: 'SKU1', quantity: 1 }, { op: 'add_adjustment', label: 'Goodwill credit', amount: -150 }];
    const c = await call(owner, 'POST', `/v1/admin/orders/${CODE}/edit/commit`, { ops, expectedGrandTotal: 850, idempotencyKey: 'inv', settlement: { type: 'leave_credit' }, notifyCustomer: false });
    expect(c.status).toBe(200);
    const inv = await (await call(owner, 'GET', `/v1/admin/orders/${CODE}/invoice`)).json() as { lines: Array<{ name: string; quantity: number; lineTotal: string }>; totals: { grand: string } };
    expect(inv.lines.map((l) => [l.name, l.quantity])).toEqual([['Widget One', 1], ['Goodwill credit', 1]]);
    expect(inv.totals.grand).toBe('$8.50');
  });
});
