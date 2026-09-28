/**
 * One-click install: setup checklist + Publish readiness gate + recovery-kit
 * download (plan §1.5/§1.10). Mirrors admin-seo.db.test.ts's seed + request
 * style. Payments/email "verified" state is seeded directly into
 * store.config (what the real verify/test-send routes would have written)
 * rather than depending on process-frozen env-managed Stripe/SMTP vars.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { hashPassword } from '../auth/password.js';
import { newTotpSecret } from '../auth/totp.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { adminSystem } from './admin-system.js';
import { adminSettings } from './admin-settings.js';

const PASSWORD = 'correct horse battery staple';

// Minimal RFC 6238 code generator — totp.ts doesn't export its internal
// hotp()/base32Decode(), and this is the only place that needs to PRODUCE a
// valid code rather than verify one.
function totpCodeFor(secretB32: string, stepOffset = 0): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secretB32.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = '';
  for (const ch of clean) { const v = B32.indexOf(ch); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const secret = Buffer.from(bytes);
  const step = Math.floor(Date.now() / 30000) + stepOffset;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

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
  const passwordHash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, 'Admin System Test Store', 'USD', $3::jsonb)`,
    [STORE, SLUG, JSON.stringify(config)],
  );
  await pool.query(`INSERT INTO admin_user (id, email, password_hash, is_installation_admin) VALUES ($1, 'install@adminsystem.test', $2, true)`, [INSTALL_ADMIN, passwordHash]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [INSTALL_ADMIN, STORE]);
  await pool.query(`INSERT INTO admin_user (id, email, password_hash) VALUES ($1, 'owner@adminsystem.test', $2)`, [OWNER_ONLY, passwordHash]);
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

  it('403s the installation administrator too, without a recent step-up', async () => {
    const { installToken } = await seed();
    const res = await req(installToken, 'GET', '/v1/admin/system/recovery-kit');
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.message).toBe('step_up_required');
  });

  it('200s after step-up, and records the download', async () => {
    const { installToken } = await seed();
    const stepUp = await req(installToken, 'POST', '/v1/admin/step-up', { password: PASSWORD });
    expect(stepUp.status).toBe(200);

    const res = await req(installToken, 'GET', '/v1/admin/system/recovery-kit');
    expect(res.status).toBe(200);
    const body = await res.json() as { masterKeyPresent: boolean; masterKey: string };
    expect(body.masterKeyPresent).toBe(true);
    expect(body.masterKey).toBe('a'.repeat(64));

    const { rows } = await pool.query(`SELECT recovery_kit_downloaded_at FROM admin_user WHERE id = $1`, [INSTALL_ADMIN]);
    expect(rows[0]?.recovery_kit_downloaded_at).not.toBeNull();
  });

  it('503s when SELLRIGHT_MASTER_KEY is not configured, even after step-up', async () => {
    const { installToken } = await seed();
    await req(installToken, 'POST', '/v1/admin/step-up', { password: PASSWORD });
    delete process.env.SELLRIGHT_MASTER_KEY;
    const res = await req(installToken, 'GET', '/v1/admin/system/recovery-kit');
    expect(res.status).toBe(503);
  });
});

describe('POST /v1/admin/step-up', () => {
  beforeEach(async () => {
    await wipe();
    process.env.SELLRIGHT_MASTER_KEY = 'a'.repeat(64);
  });
  afterAll(wipe);

  it('rejects the wrong password, and the recovery-kit stays gated', async () => {
    const { installToken } = await seed();
    const res = await req(installToken, 'POST', '/v1/admin/step-up', { password: 'not-the-password' });
    expect(res.status).toBe(401);
    expect((await req(installToken, 'GET', '/v1/admin/system/recovery-kit')).status).toBe(403);
  });

  it('requires TOTP when the admin has 2FA enabled — rejects with none, accepts with a valid code', async () => {
    const { installToken } = await seed();
    const secret = newTotpSecret();
    await pool.query(`UPDATE admin_user SET totp_secret = $1 WHERE id = $2`, [secret, INSTALL_ADMIN]);

    const noTotp = await req(installToken, 'POST', '/v1/admin/step-up', { password: PASSWORD });
    expect(noTotp.status).toBe(401);

    const wrongTotp = await req(installToken, 'POST', '/v1/admin/step-up', { password: PASSWORD, totp: '000000' });
    expect(wrongTotp.status).toBe(401);

    const ok = await req(installToken, 'POST', '/v1/admin/step-up', { password: PASSWORD, totp: totpCodeFor(secret) });
    expect(ok.status).toBe(200);
    expect((await req(installToken, 'GET', '/v1/admin/system/recovery-kit')).status).toBe(200);
  });

  it('expires after 5 minutes — a stale step-up does not silently authorize a fresh download', async () => {
    const { installToken } = await seed();
    expect((await req(installToken, 'POST', '/v1/admin/step-up', { password: PASSWORD })).status).toBe(200);
    expect((await req(installToken, 'GET', '/v1/admin/system/recovery-kit')).status).toBe(200);

    await pool.query(
      `UPDATE session SET step_up_at = now() - interval '6 minutes' WHERE admin_user_id = $1`,
      [INSTALL_ADMIN],
    );
    expect((await req(installToken, 'GET', '/v1/admin/system/recovery-kit')).status).toBe(403);
  });

  it('is per-session — stepping up one session never grants another session of the same admin', async () => {
    const { installToken } = await seed();
    const secondToken = await createAdminSession(INSTALL_ADMIN);

    expect((await req(installToken, 'POST', '/v1/admin/step-up', { password: PASSWORD })).status).toBe(200);
    expect((await req(installToken, 'GET', '/v1/admin/system/recovery-kit')).status).toBe(200);
    expect((await req(secondToken, 'GET', '/v1/admin/system/recovery-kit')).status).toBe(403);
  });

  it('is audited — records who stepped up, never the password', async () => {
    const { installToken } = await seed();
    await req(installToken, 'POST', '/v1/admin/step-up', { password: PASSWORD });
    const { rows } = await pool.query(
      `SELECT actor, action FROM audit_log WHERE store_id = $1 AND action = 'step_up_verify'`,
      [STORE],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('install@adminsystem.test');
    expect(JSON.stringify(rows[0])).not.toContain(PASSWORD);
  });

  it('rate-limits repeated failures like login', async () => {
    const { installToken } = await seed();
    let last = 200;
    for (let i = 0; i < 9; i++) {
      last = (await req(installToken, 'POST', '/v1/admin/step-up', { password: 'wrong' })).status;
    }
    expect(last).toBe(429);
  });
});
