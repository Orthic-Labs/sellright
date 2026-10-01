import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { createSession } from '../auth/session.js';
import { ownedOrder } from '../payments/gateway-payment.js';
import { account } from './account.js';
import { orders } from './orders.js';
import { checkout } from './checkout.js';

assertTestDatabase(env.DATABASE_URL, 'order provenance regressions');
const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee3333';
const OTHER_STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee4444';
const CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-0000000000a1';
const SLUG = 'order-provenance-test';
const app = new OpenAPIHono();
app.route('/', account); app.route('/', orders); app.route('/', checkout);
let token = '';
async function wipe() { await pool.query('TRUNCATE store CASCADE'); }
beforeEach(async () => {
  await wipe();
  await withStore(STORE, async tx => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, 'test'), (${OTHER_STORE}, 'other-provenance-test', 'other')`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified) VALUES (${CUSTOMER}, ${STORE}, 'victim@example.test', false)`);
    token = await createSession(tx, STORE, CUSTOMER);
    await tx.execute(sql`INSERT INTO "order" (store_id, code, customer_id, state, receipt_token, grand_total, shipping_address, metadata)
      VALUES (${STORE}, 'GUEST-MATCH', ${CUSTOMER}, 'Paid', 'receipt-capability', 8800, '{"line1":"Private address"}', '{"linked_via":"email_match"}'),
      (${STORE}, 'SESSION-ORDER', ${CUSTOMER}, 'Paid', 'direct-receipt', 1000, '{}', '{"linked_via":"session"}')`);
    await tx.execute(sql`INSERT INTO cart (store_id, token, status, converted_order_id)
      SELECT ${STORE}, 'converted-capability', 'converted', id FROM "order" WHERE code = 'GUEST-MATCH'`);
    await tx.execute(sql`INSERT INTO cart (store_id, token, status) VALUES (${STORE}, 'active-capability', 'active')`);

  });
});
afterAll(wipe);
const headers = () => ({ 'x-store-slug': SLUG, authorization: `Bearer ${token}` });
const json = async (res: Response) => await res.json() as { orders: Array<{ code: string }>; total: number; shippingAddress: { line1: string }; error: { code: string } };
const get = (path: string) => app.request(path, { headers: headers() });
const verify = () => withStore(STORE, tx => tx.execute(sql`UPDATE customer SET email_verified = true WHERE id = ${CUSTOMER}`));

describe('guest email-match provenance across all order access paths', () => {
  it('export and account listing hide matched guest orders from unverified sessions', async () => {
    const exported = await json(await get('/v1/shop/account/export'));
    expect(exported.orders.map((o: {code:string}) => o.code)).toEqual(['SESSION-ORDER']);
    const listed = await json(await get('/v1/shop/account/orders'));
    expect(listed.total).toBe(1);
    expect((await get('/v1/shop/account/orders/GUEST-MATCH')).status).toBe(404);
  });
  it('bare public order codes cannot bypass account filtering', async () => {
    expect((await get('/v1/shop/orders/GUEST-MATCH')).status).toBe(404);
    expect((await get('/v1/shop/orders/SESSION-ORDER')).status).toBe(200);
  });
  it('payment ownership rejects the same unverified match', async () => {
    await expect(withStore(STORE, tx => ownedOrder(tx, 'GUEST-MATCH', undefined, token))).rejects.toThrow('Order not found');
    expect((await withStore(STORE, tx => ownedOrder(tx, 'SESSION-ORDER', undefined, token))).code).toBe('SESSION-ORDER');
  });
  it('receipt capabilities still grant guest reads and payment access', async () => {
    expect((await get('/v1/shop/orders/GUEST-MATCH?rt=wrong')).status).toBe(404);
    const res = await app.request('/v1/shop/orders/GUEST-MATCH?rt=receipt-capability', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(200);
    expect((await json(res)).shippingAddress.line1).toBe('Private address');
    expect((await withStore(STORE, tx => ownedOrder(tx, 'GUEST-MATCH', 'receipt-capability'))).code).toBe('GUEST-MATCH');
  });
  it('verified mailbox owners can export, read and pay matched orders', async () => {
    await verify();
    expect((await json(await get('/v1/shop/account/export'))).orders).toHaveLength(2);
    expect((await get('/v1/shop/orders/GUEST-MATCH')).status).toBe(200);
    expect((await withStore(STORE, tx => ownedOrder(tx, 'GUEST-MATCH', undefined, token))).code).toBe('GUEST-MATCH');
  });
  it('receipt and session grants remain tenant-scoped under RLS', async () => {
    const res = await app.request('/v1/shop/orders/GUEST-MATCH?rt=receipt-capability', { headers: { ...headers(), 'x-store-slug': 'other-provenance-test' } });
    expect(res.status).toBe(404);
    await expect(withStore(OTHER_STORE, tx => ownedOrder(tx, 'GUEST-MATCH', 'receipt-capability', token))).rejects.toThrow('Order not found');
  });
  it('recovers the original checkout without creating orders, including empty converted carts', async () => {
    const response = await app.request('/v1/shop/cart/converted-capability/checkout', { headers: { 'x-store-slug': SLUG } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ code: 'GUEST-MATCH', receiptToken: 'receipt-capability', grandTotal: 8800, currency: 'USD' });
    expect((await app.request('/v1/shop/cart/active-capability/checkout', { headers: headers() })).status).toBe(404);
    expect((await app.request('/v1/shop/cart/not-a-capability/checkout', { headers: headers() })).status).toBe(404);
    expect((await app.request('/v1/shop/cart/converted-capability/checkout', { headers: { 'x-store-slug': 'other-provenance-test' } })).status).toBe(404);
    const countResult = await withStore(STORE, tx => tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM "order"`));
    expect(countResult.rows[0]?.count).toBe(2);
  });
  it('unverified erasure cannot scrub another mailbox owner’s guest order', async () => {
    const res = await app.request('/v1/shop/account', { method: 'DELETE', headers: headers() });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('EMAIL_NOT_VERIFIED');
    const receipt = await get('/v1/shop/orders/GUEST-MATCH?rt=receipt-capability');
    expect((await json(receipt)).shippingAddress.line1).toBe('Private address');
  });
});
