/**
 * DB tests — sequential, store-configurable order numbers (issue #309).
 *
 *   1. 20 parallel checkouts get distinct, consecutive codes (default format: no prefix, from 1001)
 *   2. a rolled-back order leaves at most a gap, never a duplicate
 *   3. PATCH refuses a format/next number that would reuse an existing code, naming the highest one
 *   4. a taken candidate code (imported history) moves the counter past it; bump after import
 *   5. admin-created orders use the same sequence; '#'-prefixed codes resolve through the receipt read + guest tracking
 *
 * Runs against a *_test database ONLY (wipes data).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { rateLimitBackend } from '../auth/rate-limit-backend.js';
import { checkout } from '../routes/checkout.js';
import { adminSettings } from '../routes/admin-settings.js';
import { adminOrderOps } from '../routes/admin-order-ops.js';
import { orders } from '../routes/orders.js';
import { shopExtra } from '../routes/shop-extra.js';
import { bumpOrderNumberPastExisting, nextOrderCode, readOrderNumbering, withOrderNumber } from './order-number.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'order-number.db.test.ts');

const STORE = 'ffffffff-0309-4000-8000-000000000001';
const SLUG = 'order-number-test-store';
const OWNER = 'ffffffff-0309-4000-8000-000000000002';
const PRODUCT = 'ffffffff-0309-4000-8000-000000000003';
const VARIANT = 'ffffffff-0309-4000-8000-000000000004';
const SKU = 'ONUM-1';

const app = new OpenAPIHono();
app.route('/', checkout);
app.route('/', adminSettings);
app.route('/', adminOrderOps);
app.route('/', orders);
app.route('/', shopExtra);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate) VALUES (${STORE}, ${SLUG}, 'Order numbers', 'USD', 0)`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'onum', 'Numbered', 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type)
      VALUES (${VARIANT}, ${STORE}, ${PRODUCT}, ${SKU}, 'Numbered', 1000, 'digital_download')`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 1000, 0)`);
  });
  await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, 'owner@onum.test')`, [OWNER]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [OWNER, STORE]);
  return createAdminSession(OWNER);
}

/** An existing order row with a given code (imported history, a legacy random code, …). */
async function existingOrder(code: string, email = 'past@onum.test') {
  await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO "order" (store_id, code, state, currency, metadata)
    VALUES (${STORE}, ${code}, 'Paid', 'USD', ${JSON.stringify({ contact: { email } })}::jsonb)`));
}

const codes = async () => (await withStore(STORE, (tx) => tx.execute(sql`SELECT code FROM "order" WHERE store_id = ${STORE} ORDER BY created_at, code`))).rows.map((r) => String((r as { code: string }).code));

function shopCheckout(n: number) {
  return app.request('/v1/shop/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-store-slug': SLUG },
    body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], email: `buyer${n}@onum.test` }),
  }, { remoteAddr: `10.9.0.${n + 1}` });
}

function admin(token: string, method: string, path: string, body?: Record<string, unknown>) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

let token = '';
beforeEach(async () => {
  for (let n = 0; n < 20; n++) await rateLimitBackend().clear('checkout-ip', `10.9.0.${n + 1}|${STORE}`);
  await wipe();
  token = await seed();
});
afterAll(async () => { await wipe(); await pool.end(); });

describe('order numbering — concurrency and rollback', () => {
  it('20 parallel checkouts get distinct, consecutive codes from the default 1001', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, (_, n) => shopCheckout(n)));
    const bodies = await Promise.all(responses.map(async (r) => ({ status: r.status, body: await r.json() as { code: string } })));
    for (const b of bodies) expect(b.status, JSON.stringify(b.body)).toBe(200);
    const got = bodies.map((b) => Number(b.body.code)).sort((a, b) => a - b);
    expect(got).toEqual(Array.from({ length: 20 }, (_, i) => 1001 + i));
    expect((await withStore(STORE, (tx) => readOrderNumbering(tx, STORE))).nextNumber).toBe(1021);
  });

  it('20 parallel allocations in separate transactions never repeat a number', async () => {
    const got = await Promise.all(Array.from({ length: 20 }, () => withStore(STORE, async (tx) => {
      const code = await nextOrderCode(tx, STORE);
      await tx.execute(sql`INSERT INTO "order" (store_id, code, currency) VALUES (${STORE}, ${code}, 'USD')`);
      return code;
    })));
    expect(new Set(got).size).toBe(20);
    expect(got.map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => 1001 + i));
  });

  it('a rolled-back order never yields a duplicate (its number returns with the rollback)', async () => {
    const first = await withStore(STORE, async (tx) => {
      const code = await nextOrderCode(tx, STORE);
      await tx.execute(sql`INSERT INTO "order" (store_id, code, currency) VALUES (${STORE}, ${code}, 'USD')`);
      return code;
    });
    let rolledBack = '';
    await expect(withStore(STORE, async (tx) => {
      rolledBack = await nextOrderCode(tx, STORE);
      await tx.execute(sql`INSERT INTO "order" (store_id, code, currency) VALUES (${STORE}, ${rolledBack}, 'USD')`);
      throw new Error('checkout failed');
    })).rejects.toThrow('checkout failed');
    const third = await withStore(STORE, async (tx) => {
      const code = await nextOrderCode(tx, STORE);
      await tx.execute(sql`INSERT INTO "order" (store_id, code, currency) VALUES (${STORE}, ${code}, 'USD')`);
      return code;
    });
    expect([first, rolledBack, third]).toEqual(['1001', '1002', '1002']);
    expect(await codes()).toEqual(['1001', '1002']);
  });

  it('a code conflict inside the order insert retries with the next number (gap, no duplicate)', async () => {
    // A concurrent writer committed 1001 after the counter was read: simulate by inserting it without moving the counter.
    const out = await withStore(STORE, async (tx) => {
      let calls = 0;
      return withOrderNumber(tx, STORE, async (code) => {
        if (calls++ === 0) await tx.execute(sql`INSERT INTO "order" (store_id, code, currency) VALUES (${STORE}, ${code}, 'USD')`);
        await tx.execute(sql`INSERT INTO "order" (store_id, code, currency) VALUES (${STORE}, ${code}, 'USD')`);
      });
    });
    expect(out.code).toBe('1002');
    expect(await codes()).toEqual(['1002']); // the first attempt's rows were rolled back to the savepoint
  });
});

describe('order numbering — settings API and collision guard', () => {
  it('GET returns the default and a preview; PATCH applies prefix/padding and checkout uses it', async () => {
    const got = await (await admin(token, 'GET', '/v1/admin/settings/order-numbering')).json();
    expect(got).toEqual({ prefix: '', suffix: '', minDigits: 0, nextNumber: 1001, preview: '1001', highestExisting: null });
    const res = await admin(token, 'PATCH', '/v1/admin/settings/order-numbering', { prefix: 'RH', minDigits: 6, nextNumber: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prefix: 'RH', suffix: '', minDigits: 6, nextNumber: 1, preview: 'RH000001', highestExisting: null });
    const order = await (await shopCheckout(0)).json() as { code: string };
    expect(order.code).toBe('RH000001');
    const admRes = await admin(token, 'POST', '/v1/admin/draft-orders', { items: [{ sku: SKU, quantity: 1 }] });
    expect(admRes.status).toBe(200);
    expect((await admRes.json() as { code: string }).code).toBe('RH000002');
    const after = await (await admin(token, 'GET', '/v1/admin/settings/order-numbering')).json();
    expect(after).toMatchObject({ nextNumber: 3, preview: 'RH000003', highestExisting: 'RH000002' });
  });

  it('refuses a next number that would reuse an existing code and names the highest one', async () => {
    await existingOrder('DD30287');
    await existingOrder('DD999');
    await existingOrder('SRA15D5DCCC0');
    const refused = await admin(token, 'PATCH', '/v1/admin/settings/order-numbering', { prefix: 'DD', nextNumber: 30000 });
    expect(refused.status).toBe(409);
    const body = await refused.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('ORDER_NUMBER_COLLISION');
    expect(body.error.message).toContain('DD30287');
    expect(body.error.message).toContain('30288');
    // Nothing changed.
    expect((await withStore(STORE, (tx) => readOrderNumbering(tx, STORE)))).toMatchObject({ prefix: '', nextNumber: 1001 });
    const ok = await admin(token, 'PATCH', '/v1/admin/settings/order-numbering', { prefix: 'DD', nextNumber: 30300 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ preview: 'DD30300', highestExisting: 'DD30287' });
  });

  it('rejects an ambiguous or malformed format', async () => {
    for (const body of [{ prefix: 'A1' }, { suffix: '9X' }, { prefix: 'a b' }, { minDigits: 13 }, { nextNumber: 0 }]) {
      const res = await admin(token, 'PATCH', '/v1/admin/settings/order-numbering', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('order numbering — existing codes', () => {
  it('a taken candidate moves the counter past the highest matching code', async () => {
    await existingOrder('1001');
    await existingOrder('1500');
    const code = await withStore(STORE, (tx) => nextOrderCode(tx, STORE));
    expect(code).toBe('1501');
  });

  it('the import bump moves the counter past the highest imported code of the configured format, never backwards', async () => {
    await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO order_number_sequence (store_id, prefix, next_number) VALUES (${STORE}, 'DD', 1)`));
    await existingOrder('DD30285'); await existingOrder('DD30287'); await existingOrder('XX99999');
    expect((await withStore(STORE, (tx) => bumpOrderNumberPastExisting(tx, STORE))).nextNumber).toBe(30288);
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE order_number_sequence SET next_number = 40000 WHERE store_id = ${STORE}`));
    expect((await withStore(STORE, (tx) => bumpOrderNumberPastExisting(tx, STORE))).nextNumber).toBe(40000);
  });

  it("'#'-prefixed codes resolve through the receipt read and guest tracking (with or without '#')", async () => {
    await admin(token, 'PATCH', '/v1/admin/settings/order-numbering', { prefix: '#', nextNumber: 1001 });
    const placed = await (await shopCheckout(0)).json() as { code: string; receiptToken: string };
    expect(placed.code).toBe('#1001');
    const receipt = await app.request(`/v1/shop/orders/${encodeURIComponent(placed.code)}?rt=${encodeURIComponent(placed.receiptToken)}`, { headers: { 'x-store-slug': SLUG } });
    expect(receipt.status).toBe(200);
    expect((await receipt.json() as { code: string }).code).toBe('#1001');
    for (const typed of ['#1001', '1001']) {
      const tracked = await app.request(`/v1/shop/track?${new URLSearchParams({ code: typed, email: 'buyer0@onum.test' })}`, { headers: { 'x-store-slug': SLUG } });
      expect(tracked.status, typed).toBe(200);
      expect((await tracked.json() as { code: string }).code).toBe('#1001');
    }
    expect(await codes()).toEqual(['#1001']);
  });
});
