/**
 * DB tests for /v1/admin/licenses — orderless (comp/support/creator) license
 * issuance. The audit requires explicit provenance + authorization: a mint call
 * without a reason is rejected, staff without the 'licenses' permission are
 * rejected, and every mint writes an audit_log row.
 *
 * Route-level — drives the real Hono handler through app.request() with seeded
 * admin sessions so auth + withStore + RLS all run as in production.
 * Runs against a *_test database ONLY (TRUNCATEs).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { createStoreAppRunner } from '../db/rls-test-utils.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminLicenses } from './admin-licenses.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`admin-licenses test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

// App-role pool: exercises FORCE ROW LEVEL SECURITY as the non-owner role.
const appPool = new Pool({ connectionString: env.DATABASE_URL_NONOWNER ?? env.DATABASE_URL });
const withStoreApp = createStoreAppRunner(appPool, { schema: s, casing: 'snake_case' });

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const STORE_B = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const SLUG = 'admin-licenses-test';
const SLUG_B = 'admin-licenses-test-b';
const OWNER = 'eeeeeeee-eeee-eeee-eeee-00000000000a';
const STAFF = 'eeeeeeee-eeee-eeee-eeee-00000000000b';

const app = new OpenAPIHono();
app.route('/', adminLicenses);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<{ ownerToken: string; staffToken: string }> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE_B}, ${SLUG_B}, ${SLUG_B}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${OWNER}, 'owner@licenses.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${STAFF}, 'staff@licenses.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${OWNER}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    // staff role WITHOUT the 'licenses' permission.
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role, permissions) VALUES (${STAFF}, ${STORE}, 'staff', '{}'::jsonb) ON CONFLICT DO NOTHING`);
  });
  return { ownerToken: await createAdminSession(OWNER), staffToken: await createAdminSession(STAFF) };
}

async function mint(token: string, body: unknown, slug = SLUG) {
  const res = await app.request('/v1/admin/licenses', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': slug, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(wipe);
afterEach(wipe);
afterAll(async () => { await pool.end(); await appPool.end(); });

describe('POST /v1/admin/licenses', () => {
  it('mints an orderless license with explicit provenance + an audit row', async () => {
    const { ownerToken } = await seed();
    const { status, body } = await mint(ownerToken, {
      appKey: 'testapp', seats: 3, reason: 'comp for reviewer — ticket 42', licenseDurationDays: 365,
    });
    expect(status).toBe(200);
    expect(body.appKey).toBe('testapp');
    expect(body.seats).toBe(3);
    expect(typeof body.licenseKey).toBe('string');

    const rows = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`
        SELECT source, order_id, order_line_id, issued_by, issue_reason, seats, expires_at IS NOT NULL AS bounded
        FROM license WHERE license_key = ${body.licenseKey as string}
      `);
      return r.rows;
    });
    expect(rows[0]).toMatchObject({
      source: 'admin', order_id: null, order_line_id: null,
      issued_by: 'owner@licenses.test', issue_reason: 'comp for reviewer — ticket 42',
      seats: 3, bounded: true,
    });

    const audit = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT actor, entity, action, data FROM audit_log WHERE entity = 'license' AND action = 'mint'`);
      return r.rows as Array<{ actor: string; data: Record<string, unknown> }>;
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe('owner@licenses.test');
    expect(audit[0]!.data.reason).toBe('comp for reviewer — ticket 42');
  });

  it('rejects a mint without an explicit reason (no silent orderless issuance)', async () => {
    const { ownerToken } = await seed();
    for (const body of [
      { appKey: 'testapp', seats: 1 },
      { appKey: 'testapp', seats: 1, reason: '' },
      { appKey: 'testapp', seats: 1, reason: '  ' },
    ]) {
      const { status } = await mint(ownerToken, body);
      expect(status).toBe(400);
    }
    const n = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int AS n FROM license`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBe(0);
  });

  it('rejects staff lacking the licenses permission', async () => {
    const { staffToken } = await seed();
    const { status } = await mint(staffToken, { appKey: 'testapp', seats: 1, reason: 'legit reason' });
    expect(status).toBe(403);
  });

  it('rejects unauthenticated callers', async () => {
    await seed();
    const res = await app.request('/v1/admin/licenses', {
      method: 'POST',
      headers: { 'x-store-slug': SLUG, 'content-type': 'application/json' },
      // Valid body (reason ≥3 chars) so zod passes and the auth failure is
      // what produces the 401.
      body: JSON.stringify({ appKey: 'testapp', seats: 1, reason: 'unauthenticated attempt' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/admin/licenses', () => {
  it('lists only the caller\u2019s store licenses (cross-tenant isolation)', async () => {
    const { ownerToken } = await seed();
    const { body: minted } = await mint(ownerToken, { appKey: 'testapp', seats: 1, reason: 'mine' });
    // A license belonging to STORE_B, written via B's own scoped context.
    await withStore(STORE_B, async (tx) => {
      await tx.execute(sql`
        INSERT INTO license (id, store_id, app_key, license_key, source, seats, issued_by, issue_reason)
        VALUES (gen_random_uuid(), ${STORE_B}, 'testapp', 'B-KEY-1', 'admin', 1, 'b@x.test', 'theirs')
      `);
    });
    // Route level: the handler's withStore scope exposes this store's key.
    const res = await app.request('/v1/admin/licenses', {
      headers: { authorization: `Bearer ${ownerToken}`, 'x-store-slug': SLUG },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ licenseKey: string }> };
    expect(body.items.map((i) => i.licenseKey)).toContain(minted.licenseKey);
    // Policy level: under the non-owner app role, RLS confines the same
    // unfiltered SELECT to the scoped store — B's row is invisible.
    const visible = await withStoreApp(STORE, (tx) =>
      tx.select({ licenseKey: s.license.licenseKey }).from(s.license));
    expect(visible.map((r) => r.licenseKey)).not.toContain('B-KEY-1');
    expect(visible.map((r) => r.licenseKey)).toContain(minted.licenseKey);
  });
});
