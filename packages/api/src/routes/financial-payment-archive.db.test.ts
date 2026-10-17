import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { assertTestDatabase, createStoreAppRunner, expectRlsRejection } from '../db/rls-test-utils.js';
import { createAdminSession } from '../auth/admin-session.js';
import { requestRefund } from '../payments/refunds.js';
import { verifyGatewayAttempt } from '../payments/gateway-payment.js';
import { adminGatewayPayments } from './admin-gateway-payments.js';

const provider = vi.hoisted(() => vi.fn(() => { throw new Error('Archive must never select a payment provider'); }));
vi.mock('../payments/provider.js', async original => ({ ...await original<typeof import('../payments/provider.js')>(), getProvider: provider }));
assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'financial-payment-archive.db.test.ts');
const STORE = 'fa000000-0000-4000-8000-000000000001', OTHER = 'fa000000-0000-4000-8000-000000000002';
const ARCHIVE = 'fa000000-0000-4000-8000-000000000003', FOREIGN = 'fa000000-0000-4000-8000-000000000004';
const ADMIN = 'fa000000-0000-4000-8000-000000000005', STAFF = 'fa000000-0000-4000-8000-000000000006';
const ORDER = 'fa000000-0000-4000-8000-000000000007', CUSTOMER = 'fa000000-0000-4000-8000-000000000008';
const DRAFT = 'fa000000-0000-4000-8000-000000000009', FOREIGN_CUSTOMER = 'fa000000-0000-4000-8000-00000000000a';
const FOREIGN_DRAFT = 'fa000000-0000-4000-8000-00000000000b';
const SLUG = 'financial-archive-test';
const app = new OpenAPIHono();
app.route('/', adminGatewayPayments);
const appPool = new Pool({ connectionString: env.DATABASE_URL_NONOWNER ?? env.DATABASE_URL });
const withApp = createStoreAppRunner(appPool, { casing: 'snake_case' });
let ownerToken = '', staffToken = '';
async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}
beforeEach(async () => {
  await wipe(); provider.mockClear();
  for (const [id, slug, archiveId, customerId, draftId] of [
    [STORE, SLUG, ARCHIVE, CUSTOMER, DRAFT], [OTHER, 'foreign-financial-archive-test', FOREIGN, FOREIGN_CUSTOMER, FOREIGN_DRAFT],
  ]) await withStore(id!, async tx => {
    await tx.insert(s.store).values({ id, slug: slug!, name: slug! });
    await tx.insert(s.customer).values({ id: customerId, storeId: id!, email: slug + '@example.test' });
    await tx.insert(s.customerAddressDraft).values({ id: draftId!, storeId: id!, customerId: customerId!,
      sourceKey: 'source:test', sourceId: '1', sourceCustomerId: '1', sourceDigest: 'd'.repeat(64), city: null });
    await tx.insert(s.financialPaymentArchive).values({ id: archiveId!, storeId: id!, sourceKey: 'source:test',
      sourceId: '99', sourceDigest: 'a'.repeat(64), state: 'Authorized', method: 'stripe', amount: 1000,
      sourceCreatedAt: '2024-03-04T12:34:56.123456', sourceOrderId: null, transactionId: 'raw-original-id',
      metadata: '{"private":"never-expose"}', errorMessage: 'private-error', importCurrencyContext: 'USD',
      sourceRecord: '{"private":"private-source"}', sourceRefunds: ['{"private":"private-refund"}'], sourceReferences: [] });
  });
  await withStore(STORE, async tx => {
    await tx.insert(s.order).values({ id: ORDER, storeId: STORE, code: 'REAL-ORDER', state: 'Paid', grandTotal: 1000 });
    await tx.insert(s.adminUser).values([{ id: ADMIN, email: 'archive-owner@example.test' }, { id: STAFF, email: 'archive-staff@example.test' }]);
    await tx.insert(s.adminUserStore).values([{ adminUserId: ADMIN, storeId: STORE, role: 'owner' }, { adminUserId: STAFF, storeId: STORE, role: 'staff' }]);
  });
  ownerToken = await createAdminSession(ADMIN); staffToken = await createAdminSession(STAFF);
});
afterAll(async () => { await wipe(); await appPool.end(); });
const request = (path: string, method = 'GET', token = ownerToken, slug = SLUG) => app.request(path, {
  method, headers: { authorization: `Bearer ${token}`, 'x-store-slug': slug, 'content-type': 'application/json' },
});

describe('private financial archives', () => {
  it('offers only scoped read access with refunds permission & no private payload exposure', async () => {
    const response = await request('/v1/admin/payment-archives');
    expect(response.status).toBe(200);
    expect(await response.clone().json()).toMatchObject({ total: 1, items: [{ id: ARCHIVE, state: 'Authorized',
      sourceOrderId: null, importCurrencyContext: 'USD', refundCount: 1, referenceCount: 0 }] });
    const raw = await response.text();
    for (const secret of ['never-expose', 'private-error', 'private-source', 'private-refund', FOREIGN]) expect(raw).not.toContain(secret);
    expect((await request('/v1/admin/payment-archives', 'GET', staffToken)).status).toBe(403);
    expect((await request('/v1/admin/payment-archives', 'GET', ownerToken, 'foreign-financial-archive-test')).status).toBe(403);
    expect((await app.request('/v1/admin/payment-archives')).status).toBe(401);
  });

  it('cannot route archive IDs into refund, capture, cancellation or relinking & dispatches zero providers', async () => {
    await expect(requestRefund({ storeId: STORE, orderId: ORDER, paymentId: ARCHIVE, amount: 10,
      idempotencyKey: 'archive-is-not-payment', actor: 'test' })).rejects.toThrow('No settled payment to refund');
    await expect(verifyGatewayAttempt(STORE, ARCHIVE)).rejects.toThrow('Payment not found');
    for (const operation of ['capture', 'refund', 'cancel', 'relink']) {
      expect((await request(`/v1/admin/payment-archives/${ARCHIVE}/${operation}`, 'POST')).status).toBe(404);
    }
    expect(provider).not.toHaveBeenCalled();
    expect(await withStore(STORE, tx => tx.select().from(s.payment))).toHaveLength(0);
    expect(await withStore(STORE, tx => tx.select().from(s.paymentAttempt))).toHaveLength(0);
    expect(await withStore(STORE, tx => tx.select().from(s.refund))).toHaveLength(0);
    expect((await withStore(STORE, tx => tx.select().from(s.financialPaymentArchive).where(eq(s.financialPaymentArchive.id, ARCHIVE))))[0]?.state).toBe('Authorized');
  });

  it('enforces both new tables under nonowner RLS, including no-context reads & cross-store writes', async () => {
    const archives = await withApp(STORE, tx => tx.execute(sql`SELECT id FROM financial_payment_archive`));
    expect(archives.rows).toEqual([{ id: ARCHIVE }]);
    const drafts = await withApp(STORE, tx => tx.execute(sql`SELECT id FROM customer_address_draft`));
    expect(drafts.rows).toEqual([{ id: DRAFT }]);
    const client = await appPool.connect();
    try {
      expect((await client.query('SELECT id FROM financial_payment_archive')).rows).toEqual([]);
      expect((await client.query('SELECT id FROM customer_address_draft')).rows).toEqual([]);
    } finally { client.release(); }
    await expectRlsRejection(withApp(STORE, tx => tx.execute(sql`UPDATE financial_payment_archive SET store_id=${OTHER} WHERE id=${ARCHIVE}`)));
    await expectRlsRejection(withApp(STORE, tx => tx.execute(sql`UPDATE customer_address_draft SET store_id=${OTHER} WHERE id=${DRAFT}`)));
  });
});
