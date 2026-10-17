import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminOrderEdit } from '../routes/admin-order-edit.js';
import { migrationId } from '../import/context.js';
import { loadEditContext, retryOrderEditRefund } from './order-edit-service.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'imported-order-history.db.test.ts');
const STORE = 'a0500000-0000-4000-8000-000000000001';
const OTHER = 'a0500000-0000-4000-8000-000000000002';
const READER = 'a0500000-0000-4000-8000-000000000003';
const OTHER_READER = 'a0500000-0000-4000-8000-000000000004';
const ORDER = 'a0500000-0000-4000-8000-000000000005';
const OTHER_ORDER = 'a0500000-0000-4000-8000-000000000006';
const IMPORTED = 'a0500000-0000-4000-8000-000000000007';
const NATIVE = 'a0500000-0000-4000-8000-000000000008';
const SLUG = 'imported-history';
const CODE = 'IMPORTED-HISTORY';
const app = new OpenAPIHono();
app.route('/', adminOrderEdit);
let reader = ''; let otherReader = '';

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
  for (const [storeId, slug, userId] of [[STORE, SLUG, READER], [OTHER, 'other-imported-history', OTHER_READER]]) {
    await withStore(storeId!, async tx => {
      await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${storeId}, ${slug}, ${slug}, 'USD')`);
      await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${userId}, ${`${slug}@example.test`}, 'unused')`);
      await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${userId}, ${storeId}, 'read_only')`);
      const orderId = storeId === STORE ? ORDER : OTHER_ORDER;
      await tx.insert(s.order).values({ id: orderId, storeId: storeId!, code: CODE, state: 'Paid', currency: 'USD', subtotal: 0, grandTotal: 0 });
      await tx.insert(s.importedOrderModification).values({
        id: storeId === STORE ? IMPORTED : migrationId(OTHER, 'source', 'modification', '7'),
        storeId: storeId!, sourceKey: 'source', sourceId: '7', sourceDigest: 'PRIVATE-DIGEST',
        sourceRecord: '{"private":"PRIVATE-RAW-SECRET","settlement":{"type":"refund_now","status":"failed"}}',
        sourceReferences: [JSON.stringify({ discriminator: 'OrderModificationLine', modificationId: 7, orderLineId: 42, quantity: -2 })],
        sourceOrderId: 'PRIVATE-SOURCE-ORDER', sourceRefundId: 'PRIVATE-SOURCE-REFUND', sourcePaymentId: 'PRIVATE-SOURCE-PAYMENT',
        orderId, scopeDisposition: 'selected_channel', sourceCreatedAt: '2024-04-03T11:22:33.123456',
        sourceUpdatedAt: '2024-04-03T11:22:33.123456', priceChange: -1200, note: storeId === STORE ? 'Visible note' : 'OTHER-STORE-SECRET',
      });
      if (storeId === STORE) {
        await tx.insert(s.orderEdit).values({ id: NATIVE, storeId: STORE, orderId: ORDER, before: {}, after: {}, balance: 0, reason: 'Native note' });
        await tx.insert(s.importedOrderModification).values({
          id: migrationId(STORE, 'source', 'modification', '8'), storeId: STORE, sourceKey: 'source', sourceId: '8',
          sourceRecord: '{}', sourceDigest: 'unused', scopeDisposition: 'other_channel', priceChange: 0, note: 'OTHER-CHANNEL-SECRET',
        });
      }
    });
  }
  reader = await createAdminSession(READER);
  otherReader = await createAdminSession(OTHER_READER);
});
afterAll(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
});

const read = (token?: string, slug = SLUG) => app.request(`/v1/admin/orders/${CODE}/edit/context`, {
  headers: { 'x-store-slug': slug, ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

describe('imported edit history authorization & native isolation', () => {
  it('requires admin membership; permitted read-only staff receive only display projection', async () => {
    expect((await read()).status).toBe(401);
    expect((await read(otherReader)).status).toBe(403);
    const response = await read(reader);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      history: [{ id: NATIVE, reason: 'Native note', settlement: null }],
      importedHistory: [{ id: IMPORTED, kind: 'imported', actionable: false, note: 'Visible note',
        createdAt: null, sourceCreatedAtText: '2024-04-03T11:22:33.123456', lineChanges: [{ quantityDelta: -2 }] }],
    });
    const wire = JSON.stringify(body);
    for (const secret of ['PRIVATE-', 'OTHER-STORE-SECRET', 'OTHER-CHANNEL-SECRET', 'sourceRecord', 'sourceReferences', 'sourceKey', 'sourceId']) {
      expect(wire).not.toContain(secret);
    }
  });

  it('same order code in another store resolves only that authorized store history', async () => {
    const response = await read(otherReader, 'other-imported-history');
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('Visible note');
    const own = await loadEditContext(STORE, CODE);
    expect(own.importedHistory).toHaveLength(1);
    expect(own.importedHistory[0]?.id).toBe(IMPORTED);
  });

  it('cannot route imported history IDs into retry or credit settlement operations', async () => {
    for (const action of ['retry', 'credit'] as const) {
      await expect(retryOrderEditRefund({ storeId: STORE, code: CODE, editId: IMPORTED, actor: 'test@example.test', action }))
        .rejects.toMatchObject({ code: 'EDIT_NOT_FOUND' });
    }
  });
});
