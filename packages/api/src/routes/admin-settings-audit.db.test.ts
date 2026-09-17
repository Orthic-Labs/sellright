/**
 * DB tests for SR-16: sensitive admin mutations must leave a durable,
 * attributable, secret-free audit_log record. Covered here:
 *   - staff role change (PATCH /v1/admin/staff/{id}) — actor, from/to role
 *   - staff permission change (PUT /v1/admin/staff/{id}/permissions) — before/after maps
 *   - store + payment settings (PATCH /v1/admin/settings/{store,payments}) — section diff
 *   - staff creation with a password — the password NEVER reaches audit_log
 *   - denied / conflicted mutations produce NO audit row (no phantom success)
 *   - tenant isolation: audit_log is FORCE-RLS'd, so a store-scoped read under
 *     the non-owner app role cannot see another store's audit rows
 *
 * Runs against sellright_test ONLY (TRUNCATEs). Mirrors rls.test.ts: owner pool
 * seeds/wipes; DATABASE_URL_NONOWNER (or DATABASE_URL when unset) drives the
 * RLS assertion so the check exercises real FORCE ROW LEVEL SECURITY.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase, createStoreAppRunner } from '../db/rls-test-utils.js';
import { adminSettings } from './admin-settings.js';
import { adminSettingsAdvanced } from './admin-settings-advanced.js';

// Safety: refuse to run against anything but a *_test database.
const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'admin-settings audit test');

// App-role pool exercises FORCE ROW LEVEL SECURITY on audit_log. Falls back to
// the owner pool when DATABASE_URL_NONOWNER is unset (single-role dev setup).
const appPool = new Pool({ connectionString: env.DATABASE_URL_NONOWNER ?? env.DATABASE_URL });
const withStoreApp = createStoreAppRunner(appPool, { schema: { auditLog: s.auditLog }, casing: 'snake_case' });

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeee0aa16';
const OTHER_STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeee0bb16';
const SLUG = 'audit-settings-test-store';
const OWNER = 'eeeeeeee-eeee-eeee-eeee-0000000016a1';
const MANAGER = 'eeeeeeee-eeee-eeee-eeee-0000000016a2';
const STAFF = 'eeeeeeee-eeee-eeee-eeee-0000000016a4';
const OWNER_EMAIL = 'owner@audit16.test';

const SENTINEL_PASSWORD = 'Passw0rd-SR16-sentinel';

const app = new OpenAPIHono();
app.route('/', adminSettings);
app.route('/', adminSettingsAdvanced);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seedAdmin(id: string, email: string, role: string, permissions?: Record<string, boolean>) {
  await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, email]);
  await pool.query(
    `INSERT INTO admin_user_store (admin_user_id, store_id, role, permissions) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [id, STORE, role, permissions ? JSON.stringify(permissions) : null],
  );
}

async function seed(): Promise<{ ownerToken: string; managerToken: string }> {
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, 'Audit Test Store', 'USD') ON CONFLICT (id) DO NOTHING`, [STORE, SLUG]);
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'audit-other-store', 'Other Store', 'USD') ON CONFLICT (id) DO NOTHING`, [OTHER_STORE]);
  await seedAdmin(OWNER, OWNER_EMAIL, 'owner');
  await seedAdmin(MANAGER, 'manager@audit16.test', 'manager');
  // legacy_extra is NOT a UI permission key — mergeStaffPermissions must pass
  // it through, so the audit before/after captures the round-trip faithfully.
  await seedAdmin(STAFF, 'staff@audit16.test', 'staff', { legacy_extra: true });
  return { ownerToken: await createAdminSession(OWNER), managerToken: await createAdminSession(MANAGER) };
}

function req(token: string, method: string, path: string, body?: Record<string, unknown>) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

interface AuditRow {
  actor: string | null;
  entity: string;
  entityId: string | null;
  action: string;
  fromState: string | null;
  toState: string | null;
  data: unknown;
}

async function auditRows(entity: string, entityId?: string): Promise<AuditRow[]> {
  return withStore(STORE, async (tx) => {
    const q = entityId
      ? sql`SELECT actor, entity, entity_id AS "entityId", action, from_state AS "fromState", to_state AS "toState", data FROM audit_log WHERE store_id = ${STORE} AND entity = ${entity} AND entity_id = ${entityId} ORDER BY at`
      : sql`SELECT actor, entity, entity_id AS "entityId", action, from_state AS "fromState", to_state AS "toState", data FROM audit_log WHERE store_id = ${STORE} AND entity = ${entity} ORDER BY at`;
    const r = await tx.execute(q);
    return r.rows as unknown as AuditRow[];
  });
}

let owner = '';
let manager = '';
beforeEach(async () => {
  await wipe();
  ({ ownerToken: owner, managerToken: manager } = await seed());
});
afterAll(async () => {
  await wipe();
  await pool.end();
  await appPool.end();
});

describe('staff role change audit', () => {
  it('writes an attributable role_change row with from/to state', async () => {
    const res = await req(owner, 'PATCH', `/v1/admin/staff/${STAFF}`, { role: 'read_only' });
    expect(res.status).toBe(200);

    const rows = await auditRows('staff', STAFF);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actor).toBe(OWNER_EMAIL);
    expect(row.action).toBe('role_change');
    expect(row.fromState).toBe('staff');
    expect(row.toState).toBe('read_only');
    // Secret-free: the payload must not carry credential material.
    expect(JSON.stringify(row.data ?? {})).not.toMatch(/password|secret|token|hash/i);
  });

  it('a DENIED role change (manager → owner) produces no audit row', async () => {
    const res = await req(manager, 'PATCH', `/v1/admin/staff/${MANAGER}`, { role: 'owner' });
    expect(res.status).toBe(403);
    expect(await auditRows('staff', MANAGER)).toHaveLength(0);
  });

  it('a 409 last-owner demote produces no audit row (nothing committed)', async () => {
    const res = await req(owner, 'PATCH', `/v1/admin/staff/${OWNER}`, { role: 'manager' });
    expect(res.status).toBe(409);
    expect(await auditRows('staff', OWNER)).toHaveLength(0);
  });
});

describe('staff permission change audit', () => {
  it('writes a permissions_update row carrying redacted before/after maps', async () => {
    const res = await req(owner, 'PUT', `/v1/admin/staff/${STAFF}/permissions`, { permissions: { refunds: true } });
    expect(res.status).toBe(200);

    const rows = await auditRows('staff', STAFF);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actor).toBe(OWNER_EMAIL);
    expect(row.action).toBe('permissions_update');
    expect(row.data).toEqual({ before: { legacy_extra: true }, after: { legacy_extra: true, refunds: true } });
  });

  it('a permissions PUT on a non-enrolled user 404s and writes no audit row', async () => {
    const ghost = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const res = await req(owner, 'PUT', `/v1/admin/staff/${ghost}/permissions`, { permissions: { refunds: true } });
    expect(res.status).toBe(404);
    expect(await auditRows('staff', ghost)).toHaveLength(0);
  });
});

describe('store/payment settings audit', () => {
  it('PATCH /v1/admin/settings/payments writes a section-scoped before/after row', async () => {
    const res = await req(owner, 'PATCH', '/v1/admin/settings/payments', { cod: false });
    expect(res.status).toBe(200);

    const rows = await auditRows('store', STORE);
    const pay = rows.filter((r) => (r.data as { section?: string }).section === 'payments');
    expect(pay).toHaveLength(1);
    expect(pay[0]!.actor).toBe(OWNER_EMAIL);
    expect((pay[0]!.data as { before: { cod: boolean } }).before.cod).toBe(true);
    expect((pay[0]!.data as { after: { cod: boolean } }).after.cod).toBe(false);
  });

  it('PATCH /v1/admin/settings/store writes a column-scoped before/after row', async () => {
    const res = await req(owner, 'PATCH', '/v1/admin/settings/store', { name: 'Renamed Store', taxRate: 875 });
    expect(res.status).toBe(200);

    const rows = await auditRows('store', STORE);
    const st = rows.filter((r) => (r.data as { section?: string }).section === 'store');
    expect(st).toHaveLength(1);
    const data = st[0]!.data as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(data.before).toEqual({ name: 'Audit Test Store', taxRate: 0 });
    expect(data.after).toEqual({ name: 'Renamed Store', taxRate: 875 });
  });
});

describe('staff creation audit — secret-free', () => {
  it('POST /v1/admin/staff records the grant but never the password', async () => {
    const res = await req(owner, 'POST', '/v1/admin/staff', { email: 'newbie@audit16.test', role: 'staff', password: SENTINEL_PASSWORD });
    expect(res.status).toBe(200);
    const { adminUserId } = (await res.json()) as { adminUserId: string };

    const rows = await auditRows('staff', adminUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('add');
    expect(rows[0]!.actor).toBe(OWNER_EMAIL);
    expect(rows[0]!.toState).toBe('staff');
    expect(rows[0]!.data).toEqual({ email: 'newbie@audit16.test' });
    // Belt-and-suspenders: scan the whole row's serialized form for the secret.
    expect(JSON.stringify(rows[0]!)).not.toContain(SENTINEL_PASSWORD);
    expect(JSON.stringify(rows[0]!)).not.toMatch(/password|hash/i);
  });
});

describe('audit_log tenant isolation', () => {
  it("store B's scoped reads cannot see store A's audit rows", async () => {
    const res = await req(owner, 'PATCH', `/v1/admin/staff/${STAFF}`, { role: 'read_only' });
    expect(res.status).toBe(200);
    expect(await auditRows('staff', STAFF)).toHaveLength(1); // positive control

    // Under the non-owner app role scoped to the OTHER store: zero rows.
    const leaked = await withStoreApp(OTHER_STORE, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = ${STAFF}`),
    );
    expect((leaked.rows[0] as { n: number }).n).toBe(0);
  });
});
