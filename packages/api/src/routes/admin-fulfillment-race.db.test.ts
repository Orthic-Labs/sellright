/** Real PostgreSQL contention: full fulfillment consumes each reserved unit once. */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';

vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: vi.fn() }));
vi.mock('../email/wake.js', () => ({ wakeEmailDelivery: vi.fn() }));

import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { onStockChanged } from '../manifest/stock-hook.js';
import { admin } from './admin.js';
import { adminOrderOps } from './admin-order-ops.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-fulfillment-race.db.test.ts');

const STORE = 'f0010000-0000-4000-8000-000000000001';
const SLUG = 'admin-fulfillment-race-test';
const ADMIN = 'f0010000-0000-4000-8000-000000000002';
const VARIANT = 'f0010000-0000-4000-8000-000000000003';
const CODE = 'FULFILL-RACE';
const app = new OpenAPIHono();
app.route('/', admin);
app.route('/', adminOrderOps);

let token = '';
let orderId = '';
let lineId = '';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

beforeEach(async () => {
  await wipe();
  vi.clearAllMocks();
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${STORE}, ${SLUG}, 'Fulfillment race', 'USD')`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@fulfillment-race.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner')`);
    const product = await tx.execute(sql`INSERT INTO product (store_id, slug, name, status) VALUES (${STORE}, 'race-product', 'Race product', 'active') RETURNING id`);
    const productId = (product.rows[0] as { id: string }).id;
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${productId}, 'FULFILL-RACE', 'Race variant', 1000)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 10, 3)`);
    const order = await tx.execute(sql`INSERT INTO "order" (store_id, code, state, currency, grand_total, metadata)
      VALUES (${STORE}, ${CODE}, 'Paid', 'USD', 3000, '{"contact":{"email":"guest@fulfillment-race.test"}}'::jsonb) RETURNING id`);
    orderId = (order.rows[0] as { id: string }).id;
    const line = await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (${STORE}, ${orderId}, ${VARIANT}, 'FULFILL-RACE', 'Race variant', 3, 1000, 3000, 3000, 0) RETURNING id`);
    lineId = (line.rows[0] as { id: string }).id;
    await tx.execute(sql`INSERT INTO webhook_endpoint (store_id, url, secret, topics, enabled)
      VALUES (${STORE}, 'https://fulfillment-race.test/hook', 'fixture-secret', ARRAY['order.shipped'], true)`);
  });
  token = await createAdminSession(ADMIN);
});

afterAll(async () => { await wipe(); await pool.end(); });

type Mode = 'single' | 'bulk';
async function fulfill(mode: Mode, state: 'Shipped' | 'Delivered' = 'Shipped') {
  return app.request(mode === 'single' ? `/v1/admin/orders/${CODE}/fulfill` : '/v1/admin/orders/bulk-fulfill', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(mode === 'single' ? { state } : { orders: [{ code: CODE, state }] }),
  });
}

async function persisted() {
  return withStore(STORE, async (tx) => {
    const order = await tx.execute(sql`SELECT * FROM "order" WHERE id = ${orderId}`);
    const lines = await tx.execute(sql`SELECT * FROM order_line WHERE order_id = ${orderId} ORDER BY id`);
    const stock = await tx.execute(sql`SELECT on_hand, allocated FROM stock WHERE variant_id = ${VARIANT}`);
    const fulfillments = await tx.execute(sql`SELECT * FROM fulfillment WHERE order_id = ${orderId} ORDER BY id`);
    const movements = await tx.execute(sql`SELECT delta, reason, ref_order_id FROM stock_movement WHERE ref_order_id = ${orderId} ORDER BY id`);
    const audits = await tx.execute(sql`SELECT * FROM audit_log WHERE entity_id = ${orderId} ORDER BY id`);
    const emails = await tx.execute(sql`SELECT * FROM email_outbox WHERE store_id = ${STORE} ORDER BY id`);
    const webhooks = await tx.execute(sql`SELECT * FROM webhook_delivery WHERE store_id = ${STORE} ORDER BY id`);
    return {
      order: order.rows[0], lines: lines.rows, stock: stock.rows[0], fulfillments: fulfillments.rows,
      movements: movements.rows, audits: audits.rows, emails: emails.rows, webhooks: webhooks.rows,
    };
  });
}

/** Wait for BOTH request transactions to reach the fixture's lock chain. */
async function waitForContenders(blockerPid: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  let count = 0;
  while (Date.now() < deadline) {
    const result = await pool.query<{ n: number }>(`
      WITH RECURSIVE blocked(pid) AS (
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
        UNION
        SELECT activity.pid FROM pg_stat_activity activity JOIN blocked
          ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        WHERE activity.datname = current_database()
      ) SELECT count(*)::int AS n FROM blocked`, [blockerPid]);
    count = result.rows[0]!.n;
    if (count >= 2) return count;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return count;
}

async function race(first: Mode, second: Mode) {
  const holder = await pool.connect();
  let requests: Promise<Response>[] = [];
  try {
    await holder.query('BEGIN');
    await holder.query("SELECT set_config('app.current_store', $1, true)", [STORE]);
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    // Old handlers both read remaining=3 before blocking on this UPDATE.
    // With order serialization, one waits here & the other waits on its order.
    await holder.query('SELECT id FROM order_line WHERE id = $1 FOR UPDATE', [lineId]);
    requests = [fulfill(first), fulfill(second)];
    expect(await waitForContenders(pid)).toBe(2);
    await holder.query('COMMIT');
    const responses = await Promise.all(requests);
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      if ([first, second][index] === 'bulk') {
        expect(body).toMatchObject({ succeeded: 1, skipped: 0, results: [{ code: CODE, ok: true, fulfillment: 'Shipped' }] });
      } else {
        expect(body).toMatchObject({ code: CODE, fulfillment: 'Shipped' });
      }
    }
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    await Promise.allSettled(requests);
  }
}

async function expectShippedOnce() {
  const result = await persisted();
  expect(result.order).toMatchObject({ state: 'Paid' });
  expect(result.stock).toEqual({ on_hand: 7, allocated: 0 });
  expect(result.lines).toEqual([expect.objectContaining({ quantity: 3, fulfilled_qty: 3, cancelled_qty: 0 })]);
  expect(result.fulfillments).toEqual([expect.objectContaining({ state: 'Shipped' })]);
  expect(result.movements).toEqual([{ delta: -3, reason: 'fulfillment', ref_order_id: orderId }]);
  expect(result.emails).toEqual([expect.objectContaining({ kind: 'shipping_notification', recipient: 'guest@fulfillment-race.test' })]);
  expect(result.webhooks).toEqual([expect.objectContaining({ topic: 'order.shipped' })]);
  expect(onStockChanged).toHaveBeenCalledTimes(1);
  expect(onStockChanged).toHaveBeenCalledWith(SLUG);
}

describe('serialized full fulfillment', () => {
  it.each<[Mode, Mode]>([['single', 'single'], ['bulk', 'bulk'], ['single', 'bulk']])(
    '%s vs %s first shipment consumes inventory & emits notifications once', async (first, second) => {
      await race(first, second);
      await expectShippedOnce();
    },
  );

  it.each(['Unfulfilled', 'Pending'] as const)('rejects single Delivered from %s without changing order data', async (from) => {
    if (from === 'Pending') {
      await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO fulfillment (store_id, order_id, state) VALUES (${STORE}, ${orderId}, 'Pending')`));
    }
    const before = await persisted();
    const response = await fulfill('single', 'Delivered');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { message: `order not fulfillable in state ${from}` } });
    expect(await persisted()).toEqual(before);
    expect(onStockChanged).not.toHaveBeenCalled();
  });

  it('advances Shipped to Delivered without consuming inventory or notifying again', async () => {
    expect((await fulfill('single')).status).toBe(200);
    await expectShippedOnce();
    const shipped = await persisted();
    const response = await fulfill('single', 'Delivered');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: CODE, fulfillment: 'Delivered' });
    const delivered = await persisted();
    expect(delivered.fulfillments).toEqual([expect.objectContaining({ id: shipped.fulfillments[0]!.id, state: 'Delivered' })]);
    expect(delivered.stock).toEqual(shipped.stock);
    expect(delivered.lines).toEqual(shipped.lines);
    expect(delivered.movements).toEqual(shipped.movements);
    expect(delivered.emails).toEqual(shipped.emails);
    expect(delivered.webhooks).toEqual(shipped.webhooks);
    expect(onStockChanged).toHaveBeenCalledTimes(1);
  });
});


describe('quarantined imported orders cannot ship or consume stock', () => {
  it.each(['single', 'partial', 'tracking'])('%s refuses before fulfillment, stock, notification or audit effects', async (mode) => {
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET metadata = metadata || '{"vendure":{"financialReconciliationV1":null}}'::jsonb WHERE id = ${orderId}`));
    const before = await persisted();
    const response = mode === 'single' ? await fulfill('single') : await app.request(
      mode === 'partial' ? `/v1/admin/orders/${CODE}/fulfillments` : '/v1/admin/import-tracking', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
        body: JSON.stringify(mode === 'partial' ? { lines: [{ orderLineId: lineId, quantity: 1 }] } : { rows: [{ code: CODE, tracking: '9400111899223856928499', carrier: 'USPS' }] }),
      });
    const body = await response.json();
    if (mode === 'tracking') {
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ updated: 0, skipped: 1, emailsQueued: 0, rows: [{ code: CODE, status: 'not_shippable', imported: false }] });
    } else {
      expect(response.status).toBe(409);
      expect(body).toMatchObject({ error: { code: 'IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED' } });
    }
    expect(await persisted()).toEqual(before);
    expect(onStockChanged).not.toHaveBeenCalled();
  });

  it('bulk fulfillment continues around a quarantined item without shipping its units', async () => {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`UPDATE "order" SET metadata = metadata || '{"vendure":{"financialReconciliationV1":false}}'::jsonb WHERE id = ${orderId}`);
      for (const code of ['NORMAL-BEFORE', 'NORMAL-AFTER']) {
        const row = await tx.execute(sql`INSERT INTO "order" (store_id, code, state, currency, grand_total) VALUES (${STORE}, ${code}, 'Paid', 'USD', 1000) RETURNING id`);
        const id = (row.rows[0] as { id: string }).id;
        await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total) VALUES (${STORE}, ${id}, ${VARIANT}, 'FULFILL-RACE', 'Race variant', 1, 1000, 1000, 1000)`);
      }
    });
    const before = await persisted();
    const response = await app.request('/v1/admin/orders/bulk-fulfill', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ orders: [{ code: 'NORMAL-BEFORE' }, { code: CODE }, { code: 'NORMAL-AFTER' }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ succeeded: 2, skipped: 1, results: [
      { code: 'NORMAL-BEFORE', ok: true }, { code: CODE, ok: false, errorCode: 'IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED' }, { code: 'NORMAL-AFTER', ok: true },
    ] });
    const after = await persisted();
    expect(after.order).toEqual(before.order);
    expect(after.lines).toEqual(before.lines);
    expect(after.fulfillments).toEqual([]);
    expect(after.movements).toEqual([]);
    expect(after.audits).toEqual([]);
    expect(after.stock).toMatchObject({ on_hand: 8, allocated: 1 });
  });
});
