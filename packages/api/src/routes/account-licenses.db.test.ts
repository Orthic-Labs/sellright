/**
 * DB tests for GET /v1/shop/account/licenses — the authed customer's issued
 * licenses, with a "latest stable version" hint per app for update nudges.
 * Mirrors account-deletion.test.ts's fixture pattern (real Postgres, TRUNCATE
 * isolation, bearer session auth).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createSession } from '../auth/session.js';
import { account } from './account.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`account-licenses test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeee1111';
const SLUG = 'account-licenses-test-store';
// Deliberately UNVERIFIED — required to exercise the email_match hiding guard
// below (a verified account's filter is a no-op; see account.ts).
const CUSTOMER = 'eeeeeeee-eeee-eeee-eeee-0000000000d1';

const app = new OpenAPIHono();
app.route('/', account);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seed(): Promise<{ token: string }> {
  return withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified) VALUES (${CUSTOMER}, ${STORE}, 'lic-owner@acct.test', false) ON CONFLICT (id) DO NOTHING`);
    const token = await createSession(tx, STORE, CUSTOMER);

    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, customer_id, state, grand_total)
      VALUES ('11111111-1111-1111-1111-111111111111', ${STORE}, 'ORD-LIC-1', ${CUSTOMER}, 'Paid', 5000)`);
    // A guest order auto-linked purely by unverified email match — must be
    // hidden from the licenses list the same way it's hidden from /orders.
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, customer_id, state, grand_total, metadata)
      VALUES ('22222222-2222-2222-2222-222222222222', ${STORE}, 'ORD-LIC-HIDDEN', ${CUSTOMER}, 'Paid', 5000, '{"linked_via":"email_match"}'::jsonb)`);

    await tx.execute(sql`INSERT INTO license (id, store_id, customer_id, order_id, app_key, license_key, status, seats, updates_until, expires_at)
      VALUES (gen_random_uuid(), ${STORE}, ${CUSTOMER}, '11111111-1111-1111-1111-111111111111', 'someapp', 'SK-ACCT-1', 'active'::license_status, 1, now() + interval '1 year', now() + interval '1 year')`);
    await tx.execute(sql`INSERT INTO license (id, store_id, customer_id, order_id, app_key, license_key, status, seats)
      VALUES (gen_random_uuid(), ${STORE}, ${CUSTOMER}, '22222222-2222-2222-2222-222222222222', 'someapp', 'SK-ACCT-HIDDEN', 'active'::license_status, 1)`);

    await tx.execute(sql`INSERT INTO app_release (id, store_id, app_key, version, channel, manifest, published_at)
      VALUES (gen_random_uuid(), ${STORE}, 'someapp', '1.0.0', 'stable', '{}'::jsonb, now() - interval '2 day')`);
    await tx.execute(sql`INSERT INTO app_release (id, store_id, app_key, version, channel, manifest, published_at)
      VALUES (gen_random_uuid(), ${STORE}, 'someapp', '1.1.0', 'stable', '{}'::jsonb, now() - interval '1 day')`);
    // A beta release published even more recently must NOT win — only 'stable' counts.
    await tx.execute(sql`INSERT INTO app_release (id, store_id, app_key, version, channel, manifest, published_at)
      VALUES (gen_random_uuid(), ${STORE}, 'someapp', '2.0.0-beta', 'beta', '{}'::jsonb, now())`);

    return { token };
  });
}

let token = '';
beforeEach(async () => {
  await wipe();
  ({ token } = await seed());
});
afterAll(async () => { await wipe(); });

const authFor = (t: string) => ({ authorization: `Bearer ${t}`, 'x-store-slug': SLUG });

describe('GET /v1/shop/account/licenses', () => {
  it('requires auth (401 without a session)', async () => {
    const res = await app.request('/v1/shop/account/licenses', { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(401);
  });

  it("returns the customer's licenses with the latest stable version, hiding email-matched guest orders' licenses for an unverified account", async () => {
    const res = await app.request('/v1/shop/account/licenses', { headers: authFor(token) });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ licenseKey: string; appKey: string; orderCode: string | null; latestVersion: string | null; seats: number }> };

    expect(body.items.map((i) => i.licenseKey)).toEqual(['SK-ACCT-1']);
    const item = body.items[0]!;
    expect(item.appKey).toBe('someapp');
    expect(item.orderCode).toBe('ORD-LIC-1');
    expect(item.seats).toBe(1);
    expect(item.latestVersion).toBe('1.1.0'); // stable only, not the newer beta
  });
});
