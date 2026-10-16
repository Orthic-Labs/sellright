/**
 * Regression: PATCH /v1/admin/discounts/{id} must apply ONLY the fields present in the request. Under Zod 4 the
 * create schema's .default() values survived .partial(), so { enabled: false } also zeroed value/freeShipping and
 * { value } re-enabled a disabled discount. Runs against a *_test database ONLY (wipes data).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { adminMarketing } from './admin-marketing.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-marketing.discount-patch.db.test.ts');

const STORE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SLUG = 'discount-patch-test-store';
const ADMIN = 'dddddddd-dddd-4ddd-8ddd-00000000000a';

const app = new OpenAPIHono();
app.route('/', adminMarketing);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

let token = '';
beforeEach(async () => {
  await wipe();
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, $2, 'USD')`, [STORE, SLUG]);
  await pool.query(`INSERT INTO admin_user (id, email, password_hash) VALUES ($1, 'owner@discount-patch.test', 'x')`, [ADMIN]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [ADMIN, STORE]);
  token = await createAdminSession(ADMIN);
});
afterEach(wipe);
afterAll(() => pool.end());

const h = () => ({ authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' });
const call = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: h(), body: body === undefined ? undefined : JSON.stringify(body) });

async function create(body: Record<string, unknown>): Promise<string> {
  const res = await call('POST', '/v1/admin/discounts', body);
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}
const detail = async (id: string) => (await (await call('GET', `/v1/admin/discounts/${id}`)).json()) as { value: number; freeShipping: boolean; enabled: boolean; code: string };

for (const base of ['/v1/admin/discounts', '/v1/admin/promotions']) {
  describe(`PATCH ${base}/{id} partial bodies`, () => {
    it('{ enabled: false } leaves value and freeShipping alone', async () => {
      const id = await create({ code: 'KEEP15', type: 'percentage', value: 15, freeShipping: true });
      expect((await call('PATCH', `${base}/${id}`, { enabled: false })).status).toBe(200);
      expect(await detail(id)).toMatchObject({ value: 15, freeShipping: true, enabled: false, code: 'KEEP15' });
    });

    it('{ value } does not re-enable a disabled discount or clear freeShipping', async () => {
      const id = await create({ code: 'OFF10', type: 'percentage', value: 10, freeShipping: true, enabled: false });
      expect((await call('PATCH', `${base}/${id}`, { value: 20 })).status).toBe(200);
      expect(await detail(id)).toMatchObject({ value: 20, freeShipping: true, enabled: false });
    });

    it('{ freeShipping: false } changes only freeShipping', async () => {
      const id = await create({ code: 'FS', type: 'fixed', value: 500, freeShipping: true });
      expect((await call('PATCH', `${base}/${id}`, { freeShipping: false })).status).toBe(200);
      expect(await detail(id)).toMatchObject({ value: 500, freeShipping: false, enabled: true });
    });

    it('an explicit value of 0 is still applied', async () => {
      const id = await create({ code: 'ZERO', type: 'fixed', value: 500 });
      expect((await call('PATCH', `${base}/${id}`, { value: 0 })).status).toBe(200);
      expect((await detail(id)).value).toBe(0);
    });

    it('still rejects an out-of-range percentage on the merged pair', async () => {
      const id = await create({ code: 'PCT', type: 'percentage', value: 10 });
      expect((await call('PATCH', `${base}/${id}`, { value: 150 })).status).toBe(400);
      expect((await detail(id)).value).toBe(10);
    });
  });
}
