/**
 * DB tests for GDPR self-service account deletion + data export (COMP-2).
 *
 *   DELETE /v1/shop/account         — hard-delete + PII cascade, anonymize orders
 *   GET    /v1/shop/account/export  — data portability snapshot
 *
 * Covers:
 *   1. delete removes addresses/sessions/carts-link/customer_tokens/payment
 *      methods but KEEPS the order row with customerId + snapshot PII nulled
 *   2. export returns the customer's own profile + addresses + order summary
 *   3. an active (non-canceled) subscription blocks deletion with 409
 *   4. unauthenticated requests get 401
 *
 * Bearer-token auth is CSRF-exempt (see auth/cookies.ts hasValidBearer), so
 * these tests don't need to simulate the CSRF cookie dance.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { createSession } from '../auth/session.js';
import { account } from './account.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`account-deletion test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SLUG = 'account-deletion-test-store';
const CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-00000000000c';

const app = new OpenAPIHono();
app.route('/', account);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seed(): Promise<string> {
  let token = '';
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, first_name, last_name) VALUES (${CUSTOMER}, ${STORE}, 'erase-me@acct.test', 'Erase', 'Me') ON CONFLICT (id) DO NOTHING`);
    token = await createSession(tx, STORE, CUSTOMER);
    // one address
    await tx.execute(sql`INSERT INTO address (id, store_id, customer_id, line1, city, country) VALUES (gen_random_uuid(), ${STORE}, ${CUSTOMER}, '1 Test St', 'Testville', 'US')`);
    // one customer_token (password reset)
    await tx.execute(sql`INSERT INTO customer_token (id, store_id, customer_id, kind, token_hash, expires_at) VALUES (gen_random_uuid(), ${STORE}, ${CUSTOMER}, 'password_reset', 'abc123', now() + interval '1 day')`);
    // a cart linked to the customer
    await tx.execute(sql`INSERT INTO cart (id, store_id, customer_id, token) VALUES (gen_random_uuid(), ${STORE}, ${CUSTOMER}, 'cart-tok-1')`);
    // an order with PII on it (customerId + shipping/billing snapshot)
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, customer_id, state, shipping_address, billing_address, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, 'ORD-1', ${CUSTOMER}, 'Paid', '{"name":"Erase Me"}'::jsonb, '{"name":"Erase Me"}'::jsonb, 5000)`);
  });
  return token;
}

const orderRow = () => withStore(STORE, async (tx) => {
  const [r] = await tx.select().from(s.order).where(eq(s.order.code, 'ORD-1')).limit(1);
  return r ?? null;
});

let token = '';
beforeEach(async () => { await wipe(); token = await seed(); });
afterAll(async () => { await wipe(); });

const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-store-slug': SLUG });

describe('GET /v1/shop/account/export', () => {
  it('returns the profile, addresses, and order summary for the authed customer', async () => {
    const res = await app.request('/v1/shop/account/export', { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      profile: { email: string; firstName: string | null };
      addresses: Array<{ line1: string }>;
      orders: Array<{ code: string; grandTotal: number }>;
    };
    expect(body.profile.email).toBe('erase-me@acct.test');
    expect(body.profile.firstName).toBe('Erase');
    expect(body.addresses).toHaveLength(1);
    expect(body.addresses[0]!.line1).toBe('1 Test St');
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]!.code).toBe('ORD-1');
    expect(body.orders[0]!.grandTotal).toBe(5000);
  });

  it('requires auth (401 without a session)', async () => {
    const res = await app.request('/v1/shop/account/export', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /v1/shop/account', () => {
  it('hard-deletes the customer + PII rows but anonymizes (keeps) the order', async () => {
    const res = await app.request('/v1/shop/account', { method: 'DELETE', headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: boolean };
    expect(body.deleted).toBe(true);

    // customer row gone
    const cust = await withStore(STORE, async (tx) => {
      const [r] = await tx.select().from(s.customer).where(eq(s.customer.id, CUSTOMER)).limit(1);
      return r ?? null;
    });
    expect(cust).toBeNull();

    // addresses gone
    const addrs = await withStore(STORE, async (tx) => tx.select().from(s.address).where(eq(s.address.customerId, CUSTOMER)));
    expect(addrs).toHaveLength(0);

    // customer_token gone
    const toks = await withStore(STORE, async (tx) => tx.select().from(s.customerToken).where(eq(s.customerToken.customerId, CUSTOMER)));
    expect(toks).toHaveLength(0);

    // sessions gone
    const sessions = await withStore(STORE, async (tx) => tx.select().from(s.session).where(eq(s.session.customerId, CUSTOMER)));
    expect(sessions).toHaveLength(0);

    // cart's customer link nulled (row survives for the TTL reaper, not linked to a person anymore)
    const cart = await withStore(STORE, async (tx) => {
      const [r] = await tx.select().from(s.cart).where(eq(s.cart.token, 'cart-tok-1')).limit(1);
      return r ?? null;
    });
    expect(cart).not.toBeNull();
    expect(cart!.customerId).toBeNull();

    // order SURVIVES (financial record) but is anonymized
    const order = await orderRow();
    expect(order).not.toBeNull();
    expect(order!.customerId).toBeNull();
    expect(order!.shippingAddress).toBeNull();
    expect(order!.billingAddress).toBeNull();
    expect(order!.grandTotal).toBe(5000); // money figures untouched
    expect((order!.metadata as Record<string, unknown> | null)?.anonymized_at).toBeDefined();
  });

  it('refuses with 409 when the customer has an active (non-canceled) subscription', async () => {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO subscription (id, store_id, customer_id, stripe_subscription_id, status)
        VALUES (gen_random_uuid(), ${STORE}, ${CUSTOMER}, 'sub_active_1', 'active')`);
    });
    const res = await app.request('/v1/shop/account', { method: 'DELETE', headers: auth() });
    expect(res.status).toBe(409);

    // nothing was touched
    const cust = await withStore(STORE, async (tx) => {
      const [r] = await tx.select().from(s.customer).where(eq(s.customer.id, CUSTOMER)).limit(1);
      return r ?? null;
    });
    expect(cust).not.toBeNull();
  });

  it('allows deletion once the subscription is canceled', async () => {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO subscription (id, store_id, customer_id, stripe_subscription_id, status)
        VALUES (gen_random_uuid(), ${STORE}, ${CUSTOMER}, 'sub_canceled_1', 'canceled')`);
    });
    const res = await app.request('/v1/shop/account', { method: 'DELETE', headers: auth() });
    expect(res.status).toBe(200);
  });

  it('requires auth (401 without a session)', async () => {
    const res = await app.request('/v1/shop/account', { method: 'DELETE', headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(401);
  });
});
