/**
 * DB tests — store.config.storefrontUrl is settable from the admin store
 * settings (PATCH/GET /v1/admin/settings/store). Sezzle return URLs and email
 * links are built from it, and no other admin path writes it.
 *
 * Runs against a *_test database ONLY (wipes data).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { adminSettings } from './admin-settings.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-settings.storefront-url.db.test.ts');

const STORE = 'ffffffff-0000-0000-0000-0000000007a1';
const SLUG = 'storefront-url-test-store';
const OWNER = 'ffffffff-0000-0000-0000-0000000007a2';
const STAFF = 'ffffffff-0000-0000-0000-0000000007a3';

const app = new OpenAPIHono();
app.route('/', adminSettings);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<{ ownerToken: string; staffToken: string }> {
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, 'URL Test Store', 'USD', $3) ON CONFLICT (id) DO NOTHING`,
    [STORE, SLUG, JSON.stringify({ hostnames: ['shop.example.test'], payments: { stripe: true } })]);
  for (const [id, email, role] of [[OWNER, 'owner@sfurl.test', 'owner'], [STAFF, 'staff@sfurl.test', 'staff']] as const) {
    await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, email]);
    await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, STORE, role]);
  }
  return { ownerToken: await createAdminSession(OWNER), staffToken: await createAdminSession(STAFF) };
}

function req(token: string, method: string, path: string, body?: Record<string, unknown>) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const configOf = async () => (await withStore(STORE, (tx) => tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, STORE))))[0]!.config as Record<string, unknown>;

beforeEach(wipe);
afterAll(async () => { await wipe(); await pool.end(); });

describe('storefrontUrl admin setting', () => {
  it('owner saves a normalised https URL, GET returns it, other config keys survive', async () => {
    const { ownerToken } = await seed();
    const res = await req(ownerToken, 'PATCH', '/v1/admin/settings/store', { storefrontUrl: ' https://shop.example.test/ ' });
    expect(res.status).toBe(200);
    expect((await configOf()).storefrontUrl).toBe('https://shop.example.test');
    expect(await configOf()).toMatchObject({ hostnames: ['shop.example.test'], payments: { stripe: true } });
    const got = await (await req(ownerToken, 'GET', '/v1/admin/settings/store')).json() as { storefrontUrl: string | null };
    expect(got.storefrontUrl).toBe('https://shop.example.test');
  });

  it('writes an audit row with before/after', async () => {
    const { ownerToken } = await seed();
    await req(ownerToken, 'PATCH', '/v1/admin/settings/store', { storefrontUrl: 'https://shop.example.test' });
    const audit = await withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.storeId, STORE)));
    const row = audit.find((a) => a.action === 'settings_update_storefront_url');
    expect(row?.data).toEqual({ before: null, after: 'https://shop.example.test' });
  });

  it('rejects non-https, credential and malformed URLs without changing config', async () => {
    const { ownerToken } = await seed();
    for (const bad of ['http://shop.example.test', 'shop.example.test', 'https://u:p@shop.example.test', 'javascript:alert(1)']) {
      const res = await req(ownerToken, 'PATCH', '/v1/admin/settings/store', { storefrontUrl: bad });
      expect(res.status, bad).toBe(400);
    }
    expect((await configOf()).storefrontUrl).toBeUndefined();
  });

  it('null or empty clears it; omitting it leaves it untouched', async () => {
    const { ownerToken } = await seed();
    await req(ownerToken, 'PATCH', '/v1/admin/settings/store', { storefrontUrl: 'https://shop.example.test' });
    await req(ownerToken, 'PATCH', '/v1/admin/settings/store', { name: 'Renamed' });
    expect((await configOf()).storefrontUrl).toBe('https://shop.example.test');
    expect((await req(ownerToken, 'PATCH', '/v1/admin/settings/store', { storefrontUrl: '' })).status).toBe(200);
    expect((await configOf()).storefrontUrl).toBeUndefined();
  });

  it('staff cannot set it', async () => {
    const { staffToken } = await seed();
    const res = await req(staffToken, 'PATCH', '/v1/admin/settings/store', { storefrontUrl: 'https://shop.example.test' });
    expect(res.status).toBe(403);
    expect((await configOf()).storefrontUrl).toBeUndefined();
  });
});
