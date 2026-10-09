/**
 * DB tests — Sezzle credentials saved through the admin Payments settings
 * (PUT /v1/admin/payments/settings/sezzle/{sandbox|production}) must be the
 * ones the runtime resolves for the store's test/live mode. The admin page
 * speaks the provider's spelling (sandbox/production); the runtime and
 * store.config.payments.sezzle.mode speak test/live. Rows already stored under
 * the runtime spelling (staged stores) must keep resolving.
 *
 * Runs against a *_test database ONLY (wipes data).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { encryptSecret, last4 } from '../security/secret-crypto.js';
import { invalidateStoreCache } from '../store-context.js';
import { adminPaymentSettings } from '../routes/admin-payment-settings.js';
import { shopConfig } from '../routes/shop-config.js';
import { resolveConfiguredGatewayAccount, resolveGatewayAccount, DB_ACCOUNT_ID } from './gateway-account.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'sezzle-admin-credentials.db.test.ts');

const STORE = 'ffffffff-0000-0000-0000-0000000008a1';
const SLUG = 'sezzle-admin-credentials-test-store';
const OWNER = 'ffffffff-0000-0000-0000-0000000008a2';

const app = new OpenAPIHono();
app.route('/', adminPaymentSettings);
app.route('/', shopConfig);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
  invalidateStoreCache();
}

async function seed(mode: 'test' | 'live'): Promise<string> {
  process.env.SELLRIGHT_MASTER_KEY = process.env.SELLRIGHT_MASTER_KEY ?? 'a'.repeat(64);
  const config = { hostnames: ['sezzle.example.test'], payments: { sezzle: { enabled: true, mode } } };
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, 'Sezzle Creds Store', 'USD', $3) ON CONFLICT (id) DO NOTHING`, [STORE, SLUG, JSON.stringify(config)]);
  await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, 'owner@sezzlecreds.test') ON CONFLICT (id) DO NOTHING`, [OWNER]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [OWNER, STORE]);
  return createAdminSession(OWNER);
}

function req(token: string | null, method: string, path: string, body?: Record<string, unknown>) {
  return app.request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Insert a secret exactly as an older runtime-spelling row would be sealed. */
async function storeLegacy(mode: string, field: string, plaintext: string) {
  const sealed = encryptSecret(plaintext, { purpose: `store:${STORE}:sezzle:${mode}:${field}` });
  await withStore(STORE, (tx) => tx.insert(s.storeSecret).values({
    storeId: STORE, provider: 'sezzle', mode, field,
    keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag, last4: last4(plaintext),
  }));
}

const config = async () => (await withStore(STORE, (tx) => tx.select({ c: s.store.config }).from(s.store)))[0]!.c;
const advertised = async () => ((await (await req(null, 'GET', '/v1/shop/config')).json()) as { gateways: { sezzle: boolean } }).gateways.sezzle;

beforeEach(wipe);
afterAll(async () => { await wipe(); await pool.end(); });

describe('Sezzle credentials saved from the admin settings page', () => {
  it('sandbox keys serve a store in test mode: shop config advertises Sezzle and the account resolves', async () => {
    const token = await seed('test');
    expect(await advertised()).toBe(false);
    const put = await req(token, 'PUT', '/v1/admin/payments/settings/sezzle/sandbox', { fields: { publicKey: 'pub-sbx', privateKey: 'priv-sbx' } });
    expect(put.status).toBe(200);
    invalidateStoreCache();
    expect(await advertised()).toBe(true);
    const account = await resolveConfiguredGatewayAccount(STORE, 'sezzle', await config());
    expect(account).toMatchObject({ accountId: DB_ACCOUNT_ID, method: 'sezzle', mode: 'test', publicKey: 'pub-sbx', privateKey: 'priv-sbx' });
    // Reconciliation resolves the persisted accountId+mode the same way.
    expect(await resolveGatewayAccount(STORE, 'sezzle', DB_ACCOUNT_ID, 'test')).toMatchObject({ publicKey: 'pub-sbx' });
  });

  it('production keys serve a store in live mode, and are not used in test mode', async () => {
    const token = await seed('live');
    await req(token, 'PUT', '/v1/admin/payments/settings/sezzle/production', { fields: { publicKey: 'pub-prod', privateKey: 'priv-prod' } });
    expect(await resolveConfiguredGatewayAccount(STORE, 'sezzle', await config())).toMatchObject({ mode: 'live', publicKey: 'pub-prod', privateKey: 'priv-prod' });
    await expect(resolveGatewayAccount(STORE, 'sezzle', DB_ACCOUNT_ID, 'test')).rejects.toThrow('Sezzle keys are not configured');
  });

  it('rows already stored under test/live (staged stores) still resolve', async () => {
    await seed('test');
    await storeLegacy('test', 'publicKey', 'pub-legacy');
    await storeLegacy('test', 'privateKey', 'priv-legacy');
    expect(await resolveGatewayAccount(STORE, 'sezzle', DB_ACCOUNT_ID, 'test')).toMatchObject({ mode: 'test', publicKey: 'pub-legacy', privateKey: 'priv-legacy' });
    await storeLegacy('live', 'publicKey', 'pub-legacy-live');
    await storeLegacy('live', 'privateKey', 'priv-legacy-live');
    expect(await resolveGatewayAccount(STORE, 'sezzle', DB_ACCOUNT_ID, 'live')).toMatchObject({ mode: 'live', publicKey: 'pub-legacy-live' });
  });

  it('admin-saved keys win over a legacy row for the same mode; mixed pairs never mix spellings per field', async () => {
    const token = await seed('test');
    await storeLegacy('test', 'publicKey', 'pub-legacy');
    await storeLegacy('test', 'privateKey', 'priv-legacy');
    await req(token, 'PUT', '/v1/admin/payments/settings/sezzle/sandbox', { fields: { publicKey: 'pub-new', privateKey: 'priv-new' } });
    expect(await resolveGatewayAccount(STORE, 'sezzle', DB_ACCOUNT_ID, 'test')).toMatchObject({ publicKey: 'pub-new', privateKey: 'priv-new' });
  });

  it('the status endpoint reports legacy-spelling rows as configured under sandbox/production', async () => {
    const token = await seed('test');
    await storeLegacy('test', 'publicKey', 'pub-legacy');
    const status = await (await req(token, 'GET', '/v1/admin/payments/settings')).json() as Record<string, Record<string, { configured: boolean; last4: string | null }>>;
    expect(status.sezzle!['sandbox:publicKey']).toMatchObject({ configured: true, last4: 'gacy' });
    expect(status.sezzle!['production:publicKey']!.configured).toBe(false);
  });
});
