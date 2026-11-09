/**
 * #406 admin tabs: with `?tab=`, GET /v1/admin/orders takes `total` from a `count(*) over()` on the page rows instead
 * of a second count statement (perf/pg #432 follow-up). The total must still be the number of matching orders on every
 * page, a page past the end must still report it (that path runs the count statement), and the window column must not
 * leak into the items. Route-level against a *_test database (wiped per case).
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { admin } from './admin.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-orders.tab-total.db.test.ts');

const STORE = 'cccccccc-cccc-cccc-cccc-cccccccc0406';
const SLUG = 'tab-total-test-store';
const ADMIN = 'cccccccc-cccc-cccc-cccc-00000000040a';

const app = new OpenAPIHono();
app.route('/', admin);

let token = '';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG})`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@tabs.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner')`);
    const order = (code: string, state: string, minutesAgo: number) => tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total, placed_at, created_at)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, ${state}::order_state, 'USD', 1000,
        now() - make_interval(mins => ${minutesAgo}), now() - make_interval(mins => ${minutesAgo}))`);
    for (let i = 1; i <= 3; i++) await order(`T-UNPAID-${i}`, 'PendingPayment', i);
    await order('T-CANCELLED', 'Cancelled', 10);
    await order('T-REFUNDED', 'Refunded', 11);
  });
  return createAdminSession(ADMIN);
}

type Page = { items: Array<Record<string, unknown>>; total: number; page: number; pageSize: number };
const list = async (query: string): Promise<Page> => {
  const res = await app.request(`/v1/admin/orders?${query}`, { headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG } });
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
};

beforeEach(async () => { await wipe(); token = await seed(); });
afterEach(wipe);
afterAll(() => pool.end());

describe('order list ?tab= total', () => {
  it('reports every matching order on each page, newest first', async () => {
    const first = await list('tab=unpaid&pageSize=2&page=1');
    expect(first.total).toBe(3);
    expect(first.items.map((r) => r.code)).toEqual(['T-UNPAID-1', 'T-UNPAID-2']);
    const second = await list('tab=unpaid&pageSize=2&page=2');
    expect(second.total).toBe(3);
    expect(second.items.map((r) => r.code)).toEqual(['T-UNPAID-3']);
  });

  it('a page past the end still reports the total', async () => {
    const past = await list('tab=unpaid&pageSize=2&page=9');
    expect(past.items).toEqual([]);
    expect(past.total).toBe(3);
  });

  it('the window total never leaks into the items', async () => {
    const { items } = await list('tab=cancelled');
    expect(items.map((r) => r.code)).toEqual(['T-CANCELLED']);
    expect(Object.keys(items[0]!)).not.toContain('matchTotal');
  });

  it('a list without a tab keeps its own count', async () => {
    const all = await list('pageSize=2');
    expect(all.total).toBe(5);
    expect(all.items).toHaveLength(2);
  });
  // BP-M2: refunded/cancelled are decided by order.state alone and no longer aggregate every order's lines and payments.
  // Before (dd, 20k orders, pg_stat_statements 2026-10-24..11-09): the aggregating all-orders statement averaged 111 ms
  // and 60,186 blocks per call (tab-counts, the same ol/pay/ref/t CTEs). Rows and totals must be unchanged.
  it('state-only tabs return the same rows and totals without the window total', async () => {
    const cancelled = await list('tab=cancelled');
    expect(cancelled.total).toBe(1);
    expect(cancelled.items.map((r) => r.code)).toEqual(['T-CANCELLED']);
    const refunded = await list('tab=refunded&pageSize=1');
    expect(refunded.total).toBe(1);
    expect(refunded.items.map((r) => r.code)).toEqual(['T-REFUNDED']);
    const past = await list('tab=refunded&page=5');
    expect(past.items).toEqual([]);
    expect(past.total).toBe(1);
  });
});

describe('order list boolean flags (API-L1)', () => {
  it('trashed=false and trashed=0 mean live orders, not the trash', async () => {
    expect((await list('trashed=false')).total).toBe(5);
    expect((await list('trashed=0')).total).toBe(5);
    expect((await list('trashed=true')).total).toBe(0);
    expect((await list('trashed=1')).total).toBe(0);
  });

  it('preOrder=false does not filter to pre-orders; anything but true/false/1/0 is a 400', async () => {
    expect((await list('preOrder=false')).total).toBe(5);
    expect((await list('preOrder=0')).total).toBe(5);
    expect((await list('preOrder=true')).total).toBe(0);
    const bad = await app.request('/v1/admin/orders?trashed=maybe', { headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG } });
    expect(bad.status).toBe(400);
  });
});
