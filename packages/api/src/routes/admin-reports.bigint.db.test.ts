/**
 * DB test (disposable test database ONLY — TRUNCATEs): money aggregates are bigint, so a range total above the int4
 * limit (2,147,483,647 cents) reads back instead of failing with a 500. Audit 2026-11-09 M-L4.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminReports } from './admin-reports.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'admin-reports.bigint.db.test.ts');

const STORE = 'cccc2222-1111-1111-1111-111111111111';
const SLUG = 'admin-reports-bigint-store';
const ADMIN = 'cccc2222-1111-1111-1111-00000000000a';

const app = new OpenAPIHono();
app.route('/', adminReports);

let token = '';
beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG})`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@reports-bigint.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner')`);
    // Two paid orders of 2,000,000,000 cents each: 4,000,000,000 in total, above int4.
    for (const code of ['BIG-1', 'BIG-2']) {
      await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, grand_total, placed_at) VALUES (gen_random_uuid(), ${STORE}, ${code}, 'Paid', 2000000000, now())`);
    }
  });
  token = await createAdminSession(ADMIN);
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

const get = (path: string) => app.request(path, { headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG } });

describe('report money sums above int4', () => {
  it('sales series total is 4,000,000,000', async () => {
    const res = await get('/v1/admin/reports/sales?days=30');
    expect(res.status).toBe(200);
    const body = await res.json() as { totalRevenue: number; series: Array<{ revenue: number }> };
    expect(body.totalRevenue).toBe(4_000_000_000);
    expect(body.series[0]!.revenue).toBe(4_000_000_000);
  });
  it('metrics revenue is 4,000,000,000 and AOV 2,000,000,000', async () => {
    const res = await get('/v1/admin/reports/metrics?days=30');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revenue: 4_000_000_000, aov: 2_000_000_000, orders: 2 });
  });
});
