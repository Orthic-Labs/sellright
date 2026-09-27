/**
 * One-click install: setup checklist + Publish readiness gate + recovery-kit
 * download (plan §1.5/§1.10). Mirrors admin-seo.db.test.ts's seed + request
 * style. Payments/email "verified" state is seeded directly into
 * store.config (what the real verify/test-send routes would have written)
 * rather than depending on process-frozen env-managed Stripe/SMTP vars.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { adminSystem } from './admin-system.js';
import { adminSettings } from './admin-settings.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-system.db.test.ts');

const STORE = 'eeeeeeee-0000-0000-0000-00000000af01';
const SLUG = 'admin-system-test-store';
const INSTALL_ADMIN = 'eeeeeeee-0000-0000-0000-00000000af02';
const OWNER_ONLY = 'eeeeeeee-0000-0000-0000-00000000af03';

const app = new OpenAPIHono();
app.route('/', adminSystem);
app.route('/', adminSettings);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(config: Record<string, unknown> = {}): Promise<{ installToken: string; ownerToken: string }> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, 'Admin System Test Store', 'USD', $3::jsonb)`,
    [STORE, SLUG, JSON.stringify(config)],
  );
  await pool.query(`INSERT INTO admin_user (id, email, is_installation_admin) VALUES ($1, 'install@adminsystem.test', true)`, [INSTALL_ADMIN]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [INSTALL_ADMIN, STORE]);
  await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, 'owner@adminsystem.test')`, [OWNER_ONLY]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [OWNER_ONLY, STORE]);
  return { installToken: await createAdminSession(INSTALL_ADMIN), ownerToken: await createAdminSession(OWNER_ONLY) };
}

function req(token: string, method: string, path: string, body?: Record<string, unknown>) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const READY_CONFIG = {
  payments: { stripe: { live: { verifiedAt: new Date().toISOString() } } },
  email: { verifiedAt: new Date().toISOString() },
};

describe('GET /v1/admin/system/checklist', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('defaults to not-ready on a brand-new store', async () => {
    const { ownerToken } = await seed();
    const body = await (await req(ownerToken, 'GET', '/v1/admin/system/checklist')).json() as { products: { ok: boolean }; domain: { ok: boolean }; payments: { ok: boolean }; email: { ok: boolean }; shippingAndTax: { ok: boolean }; recoveryKit: { ok: boolean }; offSiteBackup: { ok: boolean } };
    expect(body.products.ok).toBe(false);
    expect(body.payments.ok).toBe(false);
    expect(body.email.ok).toBe(false);
    expect(body.shippingAndTax.ok).toBe(false);
    expect(body.recoveryKit.ok).toBe(false);
    // Domain is never a blocker — no domain/TLS automation has shipped yet.
    expect(body.domain.ok).toBe(true);
  });

  it('reflects real signals once payments+email are verified in config', async () => {
    const { ownerToken } = await seed(READY_CONFIG);
    const body = await (await req(ownerToken, 'GET', '/v1/admin/system/checklist')).json() as { products: { ok: boolean }; domain: { ok: boolean }; payments: { ok: boolean }; email: { ok: boolean }; shippingAndTax: { ok: boolean }; recoveryKit: { ok: boolean }; offSiteBackup: { ok: boolean } };
    expect(body.payments.ok).toBe(true);
    expect(body.email.ok).toBe(true);
  });

  it('recoveryKit is only ever true for the installation admin, never a plain store owner', async () => {
    const { installToken, ownerToken } = await seed();
    await pool.query(`UPDATE admin_user SET recovery_kit_downloaded_at = now() WHERE id = $1`, [INSTALL_ADMIN]);
    const installBody = await (await req(installToken, 'GET', '/v1/admin/system/checklist')).json() as { products: { ok: boolean }; domain: { ok: boolean }; payments: { ok: boolean }; email: { ok: boolean }; shippingAndTax: { ok: boolean }; recoveryKit: { ok: boolean }; offSiteBackup: { ok: boolean } };
    expect(installBody.recoveryKit.ok).toBe(true);
    const ownerBody = await (await req(ownerToken, 'GET', '/v1/admin/system/checklist')).json() as { products: { ok: boolean }; domain: { ok: boolean }; payments: { ok: boolean }; email: { ok: boolean }; shippingAndTax: { ok: boolean }; recoveryKit: { ok: boolean }; offSiteBackup: { ok: boolean } };
    // OWNER_ONLY never downloaded it themselves, and isn't the installation
    // admin, so this reads false even though they own the same store.
    expect(ownerBody.recoveryKit.ok).toBe(false);
  });

  it('off-site backup is self-reported via PATCH and reflected back', async () => {
    const { ownerToken } = await seed();
    const before = await (await req(ownerToken, 'GET', '/v1/admin/system/checklist')).json() as { products: { ok: boolean }; domain: { ok: boolean }; payments: { ok: boolean }; email: { ok: boolean }; shippingAndTax: { ok: boolean }; recoveryKit: { ok: boolean }; offSiteBackup: { ok: boolean } };
    expect(before.offSiteBackup.ok).toBe(false);
    await req(ownerToken, 'PATCH', '/v1/admin/system/checklist/offsite-backup-confirmed', { confirmed: true });
    const after = await (await req(ownerToken, 'GET', '/v1/admin/system/checklist')).json() as { products: { ok: boolean }; domain: { ok: boolean }; payments: { ok: boolean }; email: { ok: boolean }; shippingAndTax: { ok: boolean }; recoveryKit: { ok: boolean }; offSiteBackup: { ok: boolean } };
    expect(after.offSiteBackup.ok).toBe(true);
  });
});

describe('PATCH /v1/admin/settings/publish — readiness gate', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('rejects publish with 409 + the list of failing checks when unready', async () => {
    const { ownerToken } = await seed();
    const res = await req(ownerToken, 'PATCH', '/v1/admin/settings/publish', { published: true });
    expect(res.status).toBe(409);
    const body = await res.json() as { failing: string[] };
    expect(body.failing).toEqual(expect.arrayContaining(['payments', 'email', 'recoveryKit']));
  });

  it('never gates going private, even when totally unready', async () => {
    const { ownerToken } = await seed();
    const res = await req(ownerToken, 'PATCH', '/v1/admin/settings/publish', { published: false });
    expect(res.status).toBe(200);
  });

  it('allows publish once payments+email are verified and the recovery kit is downloaded', async () => {
    const { installToken } = await seed(READY_CONFIG);
    await pool.query(`UPDATE admin_user SET recovery_kit_downloaded_at = now() WHERE id = $1`, [INSTALL_ADMIN]);
    const res = await req(installToken, 'PATCH', '/v1/admin/settings/publish', { published: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { published: boolean };
    expect(body.published).toBe(true);
  });

  it('still rejects when only two of the three gates are met', async () => {
    const { installToken } = await seed(READY_CONFIG); // payments+email ready, recovery kit is NOT
    const res = await req(installToken, 'PATCH', '/v1/admin/settings/publish', { published: true });
    expect(res.status).toBe(409);
    const body = await res.json() as { failing: string[] };
    expect(body.failing).toEqual(['recoveryKit']);
  });
});

describe('GET /v1/admin/system/recovery-kit', () => {
  beforeEach(async () => {
    await wipe();
    process.env.SELLRIGHT_MASTER_KEY = 'a'.repeat(64);
  });
  afterAll(wipe);

  it('403s a store owner who is not the installation administrator — owning the store is not enough', async () => {
    const { ownerToken } = await seed();
    const res = await req(ownerToken, 'GET', '/v1/admin/system/recovery-kit');
    expect(res.status).toBe(403);
  });

  it('200s for the installation administrator and records the download', async () => {
    const { installToken } = await seed();
    const res = await req(installToken, 'GET', '/v1/admin/system/recovery-kit');
    expect(res.status).toBe(200);
    const body = await res.json() as { masterKeyPresent: boolean; masterKey: string };
    expect(body.masterKeyPresent).toBe(true);
    expect(body.masterKey).toBe('a'.repeat(64));

    const { rows } = await pool.query(`SELECT recovery_kit_downloaded_at FROM admin_user WHERE id = $1`, [INSTALL_ADMIN]);
    expect(rows[0]?.recovery_kit_downloaded_at).not.toBeNull();
  });

  it('503s when SELLRIGHT_MASTER_KEY is not configured', async () => {
    const { installToken } = await seed();
    delete process.env.SELLRIGHT_MASTER_KEY;
    const res = await req(installToken, 'GET', '/v1/admin/system/recovery-kit');
    expect(res.status).toBe(503);
  });
});
