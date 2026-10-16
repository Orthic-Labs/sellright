/** SMTP status uses only the credential scope consumed by test-send. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { encryptSecret } from '../security/secret-crypto.js';
import { purposeKey, scopeFor } from './admin-payment-settings.js';
import { adminEmailSettings } from './admin-email-settings.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-email-settings.db.test.ts');

const STORE = 'ffffffff-0000-0000-0000-0000000006f1';
const SLUG = 'admin-email-settings-test-store';
const OWNER = 'ffffffff-0000-0000-0000-0000000006f2';
const app = new OpenAPIHono();
app.route('/', adminEmailSettings);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<string> {
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, 'Admin Email Settings Test Store', 'USD')`, [STORE, SLUG]);
  await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, 'owner@adminemailset.test')`, [OWNER]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [OWNER, STORE]);
  return createAdminSession(OWNER);
}

async function seedSecret(provider: Parameters<typeof scopeFor>[1], mode: string, field: string, last4: string | null = 'hint') {
  const scope = scopeFor(STORE, provider, mode, field);
  const sealed = encryptSecret('synthetic-status-fixture', { purpose: purposeKey(scope), masterKey: Buffer.alloc(32, 1) });
  await withStore(STORE, (tx) => tx.insert(s.storeSecret).values({
    storeId: STORE, provider, mode, field, last4,
    keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag,
  }));
}

async function status(token: string) {
  const res = await app.request('/v1/admin/email/settings', {
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG },
  });
  expect(res.status).toBe(200);
  return await res.json() as { envManaged: boolean; credentialConfigured: boolean };
}

const decoys = [
  ['stripe', 'default', 'authCredential'],
  ['smtp', 'test', 'authCredential'],
  ['smtp', 'default', 'webhookSecret'],
] as const;

let originalSmtpHost: string | undefined;
beforeEach(async () => {
  originalSmtpHost = env.SMTP_HOST;
  env.SMTP_HOST = undefined;
  await wipe();
});
afterEach(() => { env.SMTP_HOST = originalSmtpHost; });
afterAll(wipe);

describe('GET /v1/admin/email/settings credential scope', () => {
  it('reports false without a stored SMTP credential', async () => {
    const token = await seed();
    expect(await status(token)).toMatchObject({ envManaged: false, credentialConfigured: false });
  });

  it.each(decoys)('ignores a secret scoped to %s/%s/%s', async (provider, mode, field) => {
    const token = await seed();
    await seedSecret(provider, mode, field);
    expect(await status(token)).toMatchObject({ envManaged: false, credentialConfigured: false });
  });

  it.each([null, ''])('reports false when the exact SMTP credential has an empty hint (%s)', async (hint) => {
    const token = await seed();
    for (const [provider, mode, field] of decoys) await seedSecret(provider, mode, field);
    await seedSecret('smtp', 'default', 'authCredential', hint);
    expect(await status(token)).toMatchObject({ envManaged: false, credentialConfigured: false });
  });

  it('reports true for the exact SMTP credential even with decoys present', async () => {
    const token = await seed();
    for (const [provider, mode, field] of decoys) await seedSecret(provider, mode, field);
    await seedSecret('smtp', 'default', 'authCredential');
    expect(await status(token)).toMatchObject({ envManaged: false, credentialConfigured: true });
  });
});
