/**
 * DB tests for SEC-OWNER-1: owner-escalation / owner-lockout guards on the
 * staff routes (vs sellright_test ONLY — TRUNCATEs). Mirrors push/outbox.db.test.ts:
 * real Hono handlers via app.request(), real DB, bearer auth (CSRF-exempt).
 *
 * Before this fix, requireManage() alone gated POST/PATCH/DELETE /v1/admin/staff*,
 * and it accepts BOTH 'owner' and 'manager'. That let a manager (a) grant
 * themselves 'owner' via POST or PATCH, (b) demote the real owner to any
 * lesser role via PATCH, and (c) delete the owner's access entirely via
 * DELETE (self-removal was the only thing blocked). These tests prove all
 * three are now owner-gated, that a lone owner can't be demoted/removed
 * (leaving the store with no owner), and that ordinary staff management by a
 * manager (creating/editing non-owner rows) still works unrestricted.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminSettingsAdvanced } from './admin-settings-advanced.js';

// This suite needs a real Postgres — the shared *_test database, never a dev
// or prod one (it TRUNCATEs). Not wired into package.json's `test`/`test:db`
// split (out of scope for this change), so it self-gates: skip cleanly when
// DATABASE_URL isn't pointed at a _test database (e.g. the default `pnpm test`
// run, or a sandbox with no DB at all) instead of throwing and failing the
// whole suite. Run explicitly with DATABASE_URL=…/sellright_test to exercise it.
const isTestDb = /_test(\b|$)/.test(new URL(env.DATABASE_URL).pathname);

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeee0aaaa';
const SLUG = 'staff-owner-guard-test-store';
const OWNER = 'eeeeeeee-eeee-eeee-eeee-0000000000a1';
const MANAGER = 'eeeeeeee-eeee-eeee-eeee-0000000000a2';
const SECOND_OWNER = 'eeeeeeee-eeee-eeee-eeee-0000000000a3';
const STAFF = 'eeeeeeee-eeee-eeee-eeee-0000000000a4';

const app = new OpenAPIHono();
app.route('/', adminSettingsAdvanced);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seedAdmin(id: string, role: string) {
  await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, `${id}@staff-guard.test`]);
  await pool.query(
    `INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [id, STORE, role],
  );
}

async function seed(): Promise<{ ownerToken: string; managerToken: string }> {
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, 'Staff Guard Test', 'USD') ON CONFLICT (id) DO NOTHING`, [STORE, SLUG]);
  await seedAdmin(OWNER, 'owner');
  await seedAdmin(MANAGER, 'manager');
  await seedAdmin(STAFF, 'staff');
  return { ownerToken: await createAdminSession(OWNER), managerToken: await createAdminSession(MANAGER) };
}

function req(token: string, method: string, path: string, body?: Record<string, unknown>) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function roleOf(adminUserId: string): Promise<string | null> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(`SELECT role FROM admin_user_store WHERE admin_user_id = '${adminUserId}' AND store_id = '${STORE}'`);
    return (r.rows[0] as { role: string } | undefined)?.role ?? null;
  });
}

let owner = '';
let manager = '';
beforeEach(async () => {
  await wipe();
  ({ ownerToken: owner, managerToken: manager } = await seed());
});
afterAll(async () => { await wipe(); await pool.end(); });

describe.skipIf(!isTestDb)('POST /v1/admin/staff — owner grant gate', () => {
  it('a manager cannot create a new staff row with role owner (self or otherwise)', async () => {
    const res = await req(manager, 'POST', '/v1/admin/staff', { email: 'newowner@staff-guard.test', role: 'owner', password: 'password123' });
    expect(res.status).toBe(403);
  });

  it('a manager CAN still create an ordinary staff/read_only row (regression: not over-restricted)', async () => {
    const res = await req(manager, 'POST', '/v1/admin/staff', { email: 'newstaff@staff-guard.test', role: 'staff', password: 'password123' });
    expect(res.status).toBe(200);
  });

  it('an owner CAN create a new owner row', async () => {
    const res = await req(owner, 'POST', '/v1/admin/staff', { email: 'newowner2@staff-guard.test', role: 'owner', password: 'password123' });
    expect(res.status).toBe(200);
  });
});

describe.skipIf(!isTestDb)('PATCH /v1/admin/staff/{adminUserId} — self-elevation + owner-demotion gate', () => {
  it('a manager cannot elevate themselves to owner', async () => {
    const res = await req(manager, 'PATCH', `/v1/admin/staff/${MANAGER}`, { role: 'owner' });
    expect(res.status).toBe(403);
    expect(await roleOf(MANAGER)).toBe('manager');
  });

  it('a manager cannot demote the owner to any lesser role', async () => {
    const res = await req(manager, 'PATCH', `/v1/admin/staff/${OWNER}`, { role: 'manager' });
    expect(res.status).toBe(403);
    expect(await roleOf(OWNER)).toBe('owner');
  });

  it('a manager CAN still change another staff member\'s role between non-owner tiers (regression)', async () => {
    const res = await req(manager, 'PATCH', `/v1/admin/staff/${STAFF}`, { role: 'read_only' });
    expect(res.status).toBe(200);
    expect(await roleOf(STAFF)).toBe('read_only');
  });

  it('an owner CAN promote another staff member to owner', async () => {
    const res = await req(owner, 'PATCH', `/v1/admin/staff/${MANAGER}`, { role: 'owner' });
    expect(res.status).toBe(200);
    expect(await roleOf(MANAGER)).toBe('owner');
  });

  it('even an owner cannot demote the last remaining owner', async () => {
    const res = await req(owner, 'PATCH', `/v1/admin/staff/${OWNER}`, { role: 'manager' });
    expect(res.status).toBe(409);
    expect(await roleOf(OWNER)).toBe('owner');
  });

  it('an owner CAN demote a co-owner as long as another owner remains', async () => {
    await seedAdmin(SECOND_OWNER, 'owner');
    const res = await req(owner, 'PATCH', `/v1/admin/staff/${SECOND_OWNER}`, { role: 'manager' });
    expect(res.status).toBe(200);
    expect(await roleOf(SECOND_OWNER)).toBe('manager');
  });
});

describe.skipIf(!isTestDb)('DELETE /v1/admin/staff/{adminUserId} — owner-lockout gate', () => {
  it('a manager cannot delete the owner and take over the store', async () => {
    const res = await req(manager, 'DELETE', `/v1/admin/staff/${OWNER}`);
    expect(res.status).toBe(403);
    expect(await roleOf(OWNER)).toBe('owner');
  });

  it('a manager CAN still remove an ordinary staff member (regression)', async () => {
    const res = await req(manager, 'DELETE', `/v1/admin/staff/${STAFF}`);
    expect(res.status).toBe(200);
    expect(await roleOf(STAFF)).toBeNull();
  });

  it('the sole owner cannot remove their own access, which is the only path that would zero out the store\'s owners', async () => {
    // DELETE's owner-lockout is an emergent property of two independent
    // checks rather than one standalone rule: the pre-existing self-removal
    // guard blocks a sole owner from removing themselves, and requireOwner()
    // means the only OTHER caller who could remove an owner is a co-owner —
    // which by definition means 2+ owners exist, so the removal is safe. The
    // route's explicit countStoreOwners() <= 1 check (mirroring the PATCH
    // guard) is therefore a defense-in-depth backstop against those two
    // checks ever being loosened independently, not a reachable path today.
    const res = await req(owner, 'DELETE', `/v1/admin/staff/${OWNER}`);
    expect(res.status).toBe(409);
    expect(await roleOf(OWNER)).toBe('owner');
  });

  it('an owner CAN remove a co-owner as long as another owner remains', async () => {
    await seedAdmin(SECOND_OWNER, 'owner');
    const res = await req(owner, 'DELETE', `/v1/admin/staff/${SECOND_OWNER}`);
    expect(res.status).toBe(200);
    expect(await roleOf(SECOND_OWNER)).toBeNull();
  });
});

describe.skipIf(!isTestDb)('POST /v1/admin/staff/invites — owner grant gate', () => {
  it('a manager cannot invite someone directly into the owner role', async () => {
    const res = await req(manager, 'POST', '/v1/admin/staff/invites', { email: 'invitee@staff-guard.test', role: 'owner' });
    expect(res.status).toBe(403);
  });

  it('a manager CAN still invite a staff/read_only member (regression)', async () => {
    const res = await req(manager, 'POST', '/v1/admin/staff/invites', { email: 'invitee2@staff-guard.test', role: 'staff' });
    expect(res.status).toBe(200);
  });

  it('an owner CAN invite someone as owner', async () => {
    const res = await req(owner, 'POST', '/v1/admin/staff/invites', { email: 'invitee3@staff-guard.test', role: 'owner' });
    expect(res.status).toBe(200);
  });
});
