import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { createSession } from '../auth/session.js';
import { account } from './account.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'account-address-drafts.db.test.ts');
const STORE = 'ad000000-0000-4000-8000-000000000001';
const OTHER_STORE = 'ad000000-0000-4000-8000-000000000002';
const CUSTOMER = 'ad000000-0000-4000-8000-000000000003';
const OTHER_CUSTOMER = 'ad000000-0000-4000-8000-000000000004';
const FOREIGN_CUSTOMER = 'ad000000-0000-4000-8000-000000000005';
const DRAFT = 'ad000000-0000-4000-8000-000000000006';
const OTHER_DRAFT = 'ad000000-0000-4000-8000-000000000007';
const FOREIGN_DRAFT = 'ad000000-0000-4000-8000-000000000008';
const SLUG = 'account-drafts-test';
const app = new OpenAPIHono();
app.route('/', account);
let token = '';
async function wipe() { await pool.query('TRUNCATE store CASCADE'); }
beforeEach(async () => {
  await wipe();
  await withStore(STORE, async tx => {
    await tx.insert(s.store).values({ id: STORE, slug: SLUG, name: SLUG });
    await tx.insert(s.customer).values([
      { id: CUSTOMER, storeId: STORE, email: 'draft-owner@example.test', emailVerified: true },
      { id: OTHER_CUSTOMER, storeId: STORE, email: 'draft-other@example.test', emailVerified: true },
    ]);
    await tx.insert(s.customerAddressDraft).values([DRAFT, OTHER_DRAFT].map((id, index) => ({ id,
      storeId: STORE, customerId: index ? OTHER_CUSTOMER : CUSTOMER, sourceKey: 'vendure:test', sourceId: String(index + 1),
      sourceCustomerId: String(index + 1), sourceDigest: 'a'.repeat(64), fullName: '', line1: 'Retained street',
      line2: '', city: null, phone: '', sourceCountryId: '999', countryCode: null,
      isDefaultShipping: true, isDefaultBilling: null,
    })));
    token = await createSession(tx, STORE, CUSTOMER);
  });
  await withStore(OTHER_STORE, async tx => {
    await tx.insert(s.store).values({ id: OTHER_STORE, slug: 'foreign-drafts-test', name: 'Foreign' });
    await tx.insert(s.customer).values({ id: FOREIGN_CUSTOMER, storeId: OTHER_STORE, email: 'foreign@example.test' });
    await tx.insert(s.customerAddressDraft).values({ id: FOREIGN_DRAFT, storeId: OTHER_STORE,
      customerId: FOREIGN_CUSTOMER, sourceKey: 'vendure:test', sourceId: '1', sourceCustomerId: '1', sourceDigest: 'b'.repeat(64) });
  });
});
afterAll(wipe);
const headers = () => ({ authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' });
const complete = (id: string, body: unknown) => app.request(`/v1/shop/account/address-drafts/${id}/complete`, {
  method: 'POST', headers: headers(), body: JSON.stringify(body),
});
const valid = { fullName: 'Confirmed name', line1: '1 Main', city: 'Town', country: 'us', isDefaultShipping: true };
const drafts = () => withStore(STORE, tx => tx.select().from(s.customerAddressDraft).where(eq(s.customerAddressDraft.customerId, CUSTOMER)));

describe('customer-owned retained address drafts', () => {
  it('lists only owned tenant drafts, preserves null/empty fields & excludes drafts from checkout address list', async () => {
    const listed = await app.request('/v1/shop/account/address-drafts', { headers: headers() });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [{ id: DRAFT, fullName: '', line2: '', city: null,
      phone: '', sourceCountryId: '999', countryCode: null, isDefaultShipping: true, isDefaultBilling: null }] });
    const native = await app.request('/v1/shop/account/addresses', { headers: headers() });
    expect(await native.json()).toEqual({ items: [] });
    const anonymous = await app.request('/v1/shop/account/address-drafts', { headers: { 'x-store-slug': SLUG } });
    expect(anonymous.status).toBe(401);
    for (const id of [OTHER_DRAFT, FOREIGN_DRAFT]) {
      expect((await complete(id, valid)).status).toBe(404);
      expect((await app.request(`/v1/shop/account/address-drafts/${id}`, { method: 'DELETE', headers: headers() })).status).toBe(404);
    }
    expect(await drafts()).toHaveLength(1);
  });

  it('requires full native validation & atomically completes once under concurrent requests', async () => {
    expect((await complete(DRAFT, { line1: 'Street', country: 'US' })).status).toBe(400);
    expect(await drafts()).toHaveLength(1);
    expect(await withStore(STORE, tx => tx.select().from(s.address))).toHaveLength(0);
    const results = await Promise.all([complete(DRAFT, valid), complete(DRAFT, valid)]);
    expect(results.map(row => row.status).sort()).toEqual([201, 404]);
    expect(await drafts()).toHaveLength(0);
    const native = await withStore(STORE, tx => tx.select().from(s.address));
    expect(native).toHaveLength(1);
    expect(native[0]).toMatchObject({ customerId: CUSTOMER, fullName: 'Confirmed name', city: 'Town', country: 'US', isDefaultShipping: true });
    expect(await withStore(STORE, tx => tx.select().from(s.customerAddressDraft).where(eq(s.customerAddressDraft.customerId, OTHER_CUSTOMER)))).toHaveLength(1);
  });

  it('exports retained fields & deletes a draft without creating a native/default address', async () => {
    const exported = await app.request('/v1/shop/account/export', { headers: headers() });
    expect(await exported.json()).toMatchObject({ addresses: [], addressDrafts: [{ id: DRAFT, city: null, line2: '' }] });
    expect((await app.request(`/v1/shop/account/address-drafts/${DRAFT}`, { method: 'DELETE', headers: headers() })).status).toBe(200);
    expect(await drafts()).toHaveLength(0);
    expect(await withStore(STORE, tx => tx.select().from(s.address))).toHaveLength(0);
  });

  it('erases retained personal fields while preserving another customer’s drafts', async () => {
    expect((await app.request('/v1/shop/account', { method: 'DELETE', headers: headers() })).status).toBe(200);
    expect(await drafts()).toHaveLength(0);
    expect(await withStore(STORE, tx => tx.select().from(s.customerAddressDraft).where(eq(s.customerAddressDraft.customerId, OTHER_CUSTOMER)))).toHaveLength(1);
  });
});
