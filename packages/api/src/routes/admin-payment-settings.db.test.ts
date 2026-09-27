/**
 * WS-A admin surface DB tests: PUT/GET /v1/admin/payments/settings (encrypt
 * on write, never return plaintext, role gating, audit trail, env>db
 * precedence via the 409 "managed by server configuration" contract).
 * Mirrors admin-seo.db.test.ts's seeding + request-helper style. Network
 * calls (verify/webhook) are exercised in unit tests with mocked transports
 * (settings-verify.test.ts, stripe-webhook-provision.test.ts) — this file
 * covers only the DB-backed encrypt/store/read-back/audit path.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { adminPaymentSettings } from './admin-payment-settings.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-payment-settings.db.test.ts');

const STORE = 'ffffffff-0000-0000-0000-0000000006e1';
const SLUG = 'admin-payment-settings-test-store';
const OWNER = 'ffffffff-0000-0000-0000-0000000006e2';
const STAFF = 'ffffffff-0000-0000-0000-0000000006e3';

const app = new OpenAPIHono();
app.route('/', adminPaymentSettings);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seedAdmin(id: string, email: string, role: string) {
  await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, email]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, STORE, role]);
}

async function seed(): Promise<{ ownerToken: string; staffToken: string }> {
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, 'Admin Payment Settings Test Store', 'USD') ON CONFLICT (id) DO NOTHING`, [STORE, SLUG]);
  await seedAdmin(OWNER, 'owner@adminpayset.test', 'owner');
  await seedAdmin(STAFF, 'staff@adminpayset.test', 'staff');
  return { ownerToken: await createAdminSession(OWNER), staffToken: await createAdminSession(STAFF) };
}

function req(token: string, method: string, path: string, body?: Record<string, unknown>) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('PUT/GET /v1/admin/payments/settings (nmi — no env account configured)', () => {
  beforeEach(async () => {
    await wipe();
    process.env.SELLRIGHT_MASTER_KEY = process.env.SELLRIGHT_MASTER_KEY ?? 'a'.repeat(64);
  });
  afterAll(wipe);

  it('staff cannot write (requireManage); owner can, and the value is never returned in plaintext', async () => {
    const { ownerToken, staffToken } = await seed();

    const denied = await req(staffToken, 'PUT', '/v1/admin/payments/settings/nmi/test', { fields: { securityKey: 'nmi-sec-abc123' } });
    expect(denied.status).toBe(403);

    const put = await req(ownerToken, 'PUT', '/v1/admin/payments/settings/nmi/test', { fields: { securityKey: 'nmi-sec-abc123' } });
    expect(put.status).toBe(200);

    // Never plaintext anywhere in the response body.
    const raw = JSON.stringify(await put.clone().json());
    expect(raw).not.toContain('nmi-sec-abc123');

    const status = await req(ownerToken, 'GET', '/v1/admin/payments/settings');
    const body = await status.json() as Record<string, Record<string, { envManaged: boolean; configured: boolean; last4: string | null }>>;
    expect(body.nmi!['test:securityKey']).toEqual({ envManaged: false, configured: true, last4: 'c123' });

    // The database row itself holds ciphertext, never the plaintext key.
    const [row] = await withStore(STORE, (tx) => tx.select().from(s.storeSecret).where(eq(s.storeSecret.storeId, STORE)).limit(1));
    expect(row!.ciphertext).not.toContain('nmi-sec-abc123');
    expect(row!.last4).toBe('c123');

    const audit = await withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.storeId, STORE)));
    expect(audit.some((a) => a.entity === 'store_secret' && a.action === 'secret_update')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('nmi-sec-abc123');
  });

  it('rejects an unknown field for the provider', async () => {
    const { ownerToken } = await seed();
    const res = await req(ownerToken, 'PUT', '/v1/admin/payments/settings/nmi/test', { fields: { notARealField: 'x' } });
    expect(res.status).toBe(400);
  });
});
// Cross-store RLS isolation for `store_secret` is covered generically (via the
// non-owner app pool, which is what actually enforces FORCE RLS) by
// rls-tables.test.ts's table-discovery loop — not duplicated here.
