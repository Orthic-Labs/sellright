/**
 * P0 regression (security audit 2026-10-15): manager -> owner account takeover via the staff
 * invite flow, same store and cross-store. Real Hono app (createApp: CSRF + agent guard +
 * onError), real DB (sellright_test ONLY — TRUNCATEs).
 *
 * The attack before the fix:
 *   1. A manager (requireManage passes) POSTs /v1/admin/staff/invites for the OWNER's email with
 *      role 'staff' (no requireOwner: the role is not 'owner') and receives the raw accept token.
 *   2. POST /v1/admin/staff/accept {token, password} with no authentication REPLACED the existing
 *      owner's password hash (setAdminPassword) and onConflictDoUpdate'd the owner's role.
 *   3. The manager signs in as the owner. Cross-store: the invite is created in the manager's own
 *      store for the owner of ANOTHER store, and the password reset takes over that store too.
 * Also: POST /v1/admin/staff (onConflictDoUpdate) let a manager demote an owner, and
 * POST /v1/admin/staff/{id}/revoke-sessions let a manager force-logout an owner.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

const sent = vi.hoisted(() => ({ mails: [] as Array<{ to: string; acceptUrl: string }>, deliver: true }));
vi.mock('./email/dispatch.js', async (orig) => ({
  ...(await orig<typeof import('./email/dispatch.js')>()),
  sendStaffInvite: vi.fn(async (_store: unknown, to: string, data: { acceptUrl: string }) => {
    if (!sent.deliver) return { delivered: false, reason: 'smtp_not_configured' };
    sent.mails.push({ to, acceptUrl: data.acceptUrl });
    return { delivered: true };
  }),
}));

import { createApp } from './app.js';
import { pool } from './db/client.js';
import { env, adminPublicUrl } from './env.js';
import { createAdminSession } from './auth/admin-session.js';
import { hashPassword, verifyPassword } from './auth/password.js';
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from './auth/rate-limit-backend.js';

// TRUNCATEs: only ever against a database whose NAME ends in _test (the pathname, not the whole URL —
// a user/host containing "_test" must not qualify).
const isTestDb = /^\/[^/]*_test$/.test(new URL(process.env.DATABASE_URL ?? env.DATABASE_URL).pathname);

const STORE_A = 'ffffffff-ffff-ffff-ffff-ffffffff0a0a';
const STORE_B = 'ffffffff-ffff-ffff-ffff-ffffffff0b0b';
const OWNER_A = 'ffffffff-ffff-ffff-ffff-0000000000a1';
const MANAGER_A = 'ffffffff-ffff-ffff-ffff-0000000000a2';
const OWNER_B = 'ffffffff-ffff-ffff-ffff-0000000000b1';
const STAFF_A = 'ffffffff-ffff-ffff-ffff-0000000000a3';
const OWNER_A_EMAIL = 'owner-a@takeover.test';
const OWNER_B_EMAIL = 'owner-b@takeover.test';
const OWNER_PASSWORD = 'owner-real-password-1';
const ATTACKER_PASSWORD = 'attacker-chosen-pass';

const app = createApp();
let ownerHashA = '';
let ownerHashB = '';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM staff_invite');
  await pool.query('DELETE FROM admin_user');
}

async function seed() {
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'takeover-a', 'Store A', 'USD'), ($2, 'takeover-b', 'Store B', 'USD')`, [STORE_A, STORE_B]);
  ownerHashA = await hashPassword(OWNER_PASSWORD);
  ownerHashB = await hashPassword(OWNER_PASSWORD);
  await pool.query(`INSERT INTO admin_user (id, email, password_hash) VALUES ($1, $2, $3), ($4, $5, $6), ($7, 'manager-a@takeover.test', $8), ($9, 'staff-a@takeover.test', $8)`,
    [OWNER_A, OWNER_A_EMAIL, ownerHashA, OWNER_B, OWNER_B_EMAIL, ownerHashB, MANAGER_A, await hashPassword('manager-password-1'), STAFF_A]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner'), ($3, $2, 'manager'), ($4, $5, 'owner'), ($6, $2, 'staff')`,
    [OWNER_A, STORE_A, MANAGER_A, OWNER_B, STORE_B, STAFF_A]);
}

function call(method: string, path: string, opts: { token?: string; slug?: string; body?: unknown; cookieToken?: string; csrf?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.slug) headers['x-store-slug'] = opts.slug;
  if (opts.cookieToken) headers.cookie = `sr_admin=${opts.cookieToken}${opts.csrf ? `; sr_csrf=${opts.csrf}` : ''}`;
  if (opts.csrf) headers['x-csrf-token'] = opts.csrf;
  return app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}

async function passwordHashOf(id: string): Promise<string> {
  const r = await pool.query('SELECT password_hash FROM admin_user WHERE id = $1', [id]);
  return r.rows[0].password_hash as string;
}
async function roleOf(id: string, storeId: string): Promise<string | null> {
  const r = await pool.query('SELECT role FROM admin_user_store WHERE admin_user_id = $1 AND store_id = $2', [id, storeId]);
  return (r.rows[0]?.role as string | undefined) ?? null;
}
/** A leaked/intercepted invite token: the DB holds only its sha256, exactly like the route writes it. */
async function plantInvite(storeId: string, email: string, role: string): Promise<string> {
  const token = randomBytes(24).toString('hex');
  await pool.query(`INSERT INTO staff_invite (store_id, email, role, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
    [storeId, email, role, createHash('sha256').update(token).digest('hex')]);
  return token;
}
async function login(email: string, password: string) {
  return call('POST', '/v1/admin/login', { body: { email, password } });
}

let manager = '';
beforeEach(async () => {
  if (!isTestDb) return;
  sent.mails.length = 0;
  sent.deliver = true;
  _setRateLimitBackendForTest(createMemoryRateLimitBackend());
  await wipe();
  await seed();
  manager = await createAdminSession(MANAGER_A);
});
afterAll(async () => { if (isTestDb) await wipe(); await pool.end(); });

describe.skipIf(!isTestDb)('P0: manager -> owner takeover through staff invites', () => {
  it('same store: the owner (a member) cannot be invited at all, and no invite response carries the raw accept token', async () => {
    const own = await call('POST', '/v1/admin/staff/invites', { token: manager, slug: 'takeover-a', body: { email: OWNER_A_EMAIL, role: 'staff' } });
    expect(own.status).toBe(409);
    expect(JSON.stringify(await own.json())).not.toMatch(/[0-9a-f]{48}/);
    expect(sent.mails).toHaveLength(0);
    const NEW = 'newcomer@takeover.test';
    const res = await call('POST', '/v1/admin/staff/invites', { token: manager, slug: 'takeover-a', body: { email: NEW, role: 'staff' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('acceptUrl');
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{48}/);
    // delivered by e-mail only, to the invited address
    expect(sent.mails).toHaveLength(1);
    expect(sent.mails[0]!.to).toBe(NEW);
    // the link targets the admin SPA (ADMIN_PUBLIC_URL, default STOREFRONT_URL/admin), never a request-derived host
    expect(sent.mails[0]!.acceptUrl).toBe(`${adminPublicUrl()}/accept-invite?token=${new URL(sent.mails[0]!.acceptUrl).searchParams.get('token')}`);
    expect(sent.mails[0]!.acceptUrl).toMatch(/\/admin\/accept-invite\?token=[0-9a-f]{64}$/);
  });

  it('same store: an unauthenticated accept of a (leaked) token for the owner cannot reset the owner password or role', async () => {
    const token = await plantInvite(STORE_A, OWNER_A_EMAIL, 'staff');
    const res = await call('POST', '/v1/admin/staff/accept', { body: { token, password: ATTACKER_PASSWORD } });
    expect(res.status).toBe(401);
    expect(await passwordHashOf(OWNER_A)).toBe(ownerHashA);
    expect(await roleOf(OWNER_A, STORE_A)).toBe('owner');
    expect((await login(OWNER_A_EMAIL, ATTACKER_PASSWORD)).status).toBe(401);
    expect((await login(OWNER_A_EMAIL, OWNER_PASSWORD)).status).toBe(200);
  });

  it('cross store: a manager of store A cannot take over the owner of store B', async () => {
    const res = await call('POST', '/v1/admin/staff/invites', { token: manager, slug: 'takeover-a', body: { email: OWNER_B_EMAIL, role: 'staff' } });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('token');
    // even with the token in hand (e.g. leaked from the mail), accept must not touch the B owner's credentials
    const token = await plantInvite(STORE_A, OWNER_B_EMAIL, 'staff');
    const acc = await call('POST', '/v1/admin/staff/accept', { body: { token, password: ATTACKER_PASSWORD } });
    expect(acc.status).toBe(401);
    expect(await passwordHashOf(OWNER_B)).toBe(ownerHashB);
    expect(await roleOf(OWNER_B, STORE_B)).toBe('owner');
    expect(await roleOf(OWNER_B, STORE_A)).toBeNull();
    expect((await login(OWNER_B_EMAIL, ATTACKER_PASSWORD)).status).toBe(401);
  });

  it('a wrong current password does not accept, and is counted like a failed login', async () => {
    const token = await plantInvite(STORE_A, OWNER_B_EMAIL, 'staff');
    const acc = await call('POST', '/v1/admin/staff/accept', { body: { token, currentPassword: ATTACKER_PASSWORD } });
    expect(acc.status).toBe(401);
    expect(await roleOf(OWNER_B, STORE_A)).toBeNull();
    const inv = await pool.query('SELECT accepted_at FROM staff_invite WHERE email = $1', [OWNER_B_EMAIL]);
    expect(inv.rows[0].accepted_at).toBeNull();
  });

  it('POST /v1/admin/staff: a manager cannot demote an owner through the upsert path', async () => {
    const res = await call('POST', '/v1/admin/staff', { token: manager, slug: 'takeover-a', body: { email: OWNER_A_EMAIL, role: 'staff', password: ATTACKER_PASSWORD } });
    expect(res.status).toBe(403);
    expect(await roleOf(OWNER_A, STORE_A)).toBe('owner');
    expect(await passwordHashOf(OWNER_A)).toBe(ownerHashA);
  });

  it('POST /v1/admin/staff: even an owner cannot demote the last owner through the upsert path', async () => {
    const owner = await createAdminSession(OWNER_A);
    const res = await call('POST', '/v1/admin/staff', { token: owner, slug: 'takeover-a', body: { email: OWNER_A_EMAIL, role: 'manager', password: 'whatever-123' } });
    expect(res.status).toBe(409);
    expect(await roleOf(OWNER_A, STORE_A)).toBe('owner');
  });

  it('revoke-sessions: a manager cannot force-logout an owner', async () => {
    const ownerSession = await createAdminSession(OWNER_A);
    const res = await call('POST', `/v1/admin/staff/${OWNER_A}/revoke-sessions`, { token: manager, slug: 'takeover-a' });
    expect(res.status).toBe(403);
    expect((await call('GET', '/v1/admin/me', { token: ownerSession })).status).toBe(200);
  });

  it('revoke-sessions: a manager cannot force-logout a staff member who owns another store', async () => {
    await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'staff')`, [OWNER_B, STORE_A]);
    const res = await call('POST', `/v1/admin/staff/${OWNER_B}/revoke-sessions`, { token: manager, slug: 'takeover-a' });
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!isTestDb)('P0: invites cannot restore revoked access', () => {
  it('a current member cannot be invited (no self-invite kept back for later)', async () => {
    const res = await call('POST', '/v1/admin/staff/invites', { token: manager, slug: 'takeover-a', body: { email: 'manager-a@takeover.test', role: 'manager' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ALREADY_MEMBER');
    expect(sent.mails).toHaveLength(0);
  });

  it('a demotion revokes the person\'s pending invites: an older invite cannot restore manager', async () => {
    const token = await plantInvite(STORE_A, 'manager-a@takeover.test', 'manager');
    const owner = await createAdminSession(OWNER_A);
    expect((await call('PATCH', `/v1/admin/staff/${MANAGER_A}`, { token: owner, slug: 'takeover-a', body: { role: 'read_only' } })).status).toBe(200);
    const acc = await call('POST', '/v1/admin/staff/accept', { body: { token, currentPassword: 'manager-password-1' } });
    expect(acc.status).toBe(409);
    expect(await roleOf(MANAGER_A, STORE_A)).toBe('read_only');
  });

  it('a removal revokes the person\'s pending invites: an older invite cannot restore access', async () => {
    const token = await plantInvite(STORE_A, 'staff-a@takeover.test', 'staff');
    const owner = await createAdminSession(OWNER_A);
    expect((await call('DELETE', `/v1/admin/staff/${STAFF_A}`, { token: owner, slug: 'takeover-a' })).status).toBe(200);
    const session = await createAdminSession(STAFF_A);
    const acc = await call('POST', '/v1/admin/staff/accept', { token: session, body: { token } });
    expect(acc.status).toBe(409);
    expect(await roleOf(STAFF_A, STORE_A)).toBeNull();
  });
});

describe.skipIf(!isTestDb)('P0: concurrent membership changes are serialized', () => {
  it('a manager upsert racing an owner grant cannot demote the new owner (the membership did not exist when it was read)', async () => {
    // A concurrent owner-side transaction holds the store's membership lock and inserts the target as owner.
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`staff-membership:${STORE_A}`]);
      await other.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [OWNER_B, STORE_A]);
      const pending = call('POST', '/v1/admin/staff', { token: manager, slug: 'takeover-a', body: { email: OWNER_B_EMAIL, role: 'staff', password: 'irrelevant-1' } });
      // Wait until the manager's request is parked behind the other transaction (any ungranted lock in pg_locks —
      // the membership lock with the fix, the conflicting row's insert without it), never a fixed sleep.
      let waiting = 0;
      for (let i = 0; i < 400 && !waiting; i++) {
        waiting = (await pool.query(`SELECT 1 FROM pg_locks WHERE NOT granted`)).rowCount ?? 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting).toBeGreaterThan(0);
      await other.query('COMMIT');
      expect((await pending).status).toBe(403);
    } finally {
      other.release();
    }
    expect(await roleOf(OWNER_B, STORE_A)).toBe('owner');
  });
});

describe.skipIf(!isTestDb)('P0: legitimate invite acceptance still works', () => {
  it('a brand-new invitee sets their password with the token', async () => {
    const token = await plantInvite(STORE_A, 'fresh@takeover.test', 'staff');
    const res = await call('POST', '/v1/admin/staff/accept', { body: { token, password: 'fresh-password-1' } });
    expect(res.status).toBe(200);
    expect((await login('fresh@takeover.test', 'fresh-password-1')).status).toBe(200);
    // single use
    expect((await call('POST', '/v1/admin/staff/accept', { body: { token, password: 'fresh-password-2' } })).status).toBe(409);
  });

  it('a brand-new invitee must choose a password', async () => {
    const token = await plantInvite(STORE_A, 'nopass@takeover.test', 'staff');
    const res = await call('POST', '/v1/admin/staff/accept', { body: { token } });
    expect(res.status).toBe(400);
  });

  it('an existing admin accepts by proving their current password; the password is not changed', async () => {
    const token = await plantInvite(STORE_A, OWNER_B_EMAIL, 'staff');
    const res = await call('POST', '/v1/admin/staff/accept', { body: { token, currentPassword: OWNER_PASSWORD, password: ATTACKER_PASSWORD } });
    expect(res.status).toBe(200);
    expect(await roleOf(OWNER_B, STORE_A)).toBe('staff');
    expect(await roleOf(OWNER_B, STORE_B)).toBe('owner');
    expect(await passwordHashOf(OWNER_B)).toBe(ownerHashB);
    expect(await verifyPassword(OWNER_PASSWORD, await passwordHashOf(OWNER_B))).toBe(true);
  });

  it('an existing admin accepts from their own authenticated session (cookie + CSRF)', async () => {
    const token = await plantInvite(STORE_A, OWNER_B_EMAIL, 'manager');
    const session = await createAdminSession(OWNER_B);
    const noCsrf = await call('POST', '/v1/admin/staff/accept', { cookieToken: session, body: { token } });
    expect(noCsrf.status).toBe(403);
    const res = await call('POST', '/v1/admin/staff/accept', { cookieToken: session, csrf: 'c'.repeat(32), body: { token } });
    expect(res.status).toBe(200);
    expect(await roleOf(OWNER_B, STORE_A)).toBe('manager');
  });

  it('a session for a DIFFERENT admin does not satisfy an existing account\'s proof', async () => {
    const token = await plantInvite(STORE_A, OWNER_B_EMAIL, 'manager');
    const res = await call('POST', '/v1/admin/staff/accept', { token: manager, body: { token } });
    expect(res.status).toBe(401);
    expect(await roleOf(OWNER_B, STORE_A)).toBeNull();
  });

  it('accept never demotes a current owner of the store', async () => {
    const token = await plantInvite(STORE_A, OWNER_A_EMAIL, 'staff');
    const res = await call('POST', '/v1/admin/staff/accept', { body: { token, currentPassword: OWNER_PASSWORD } });
    expect(res.status).toBe(409);
    expect(await roleOf(OWNER_A, STORE_A)).toBe('owner');
  });

  it('with no e-mail delivery configured the invite is refused explicitly and nothing is persisted', async () => {
    sent.deliver = false;
    const res = await call('POST', '/v1/admin/staff/invites', { token: manager, slug: 'takeover-a', body: { email: 'nomail@takeover.test', role: 'staff' } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVITE_EMAIL_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{48}/);
    const rows = await pool.query('SELECT 1 FROM staff_invite WHERE email = $1', ['nomail@takeover.test']);
    expect(rows.rowCount).toBe(0);
  });

  it('an owner may still revoke a co-owner of THIS store only, and a manager may revoke ordinary staff', async () => {
    const CO = 'ffffffff-ffff-ffff-ffff-0000000000a9';
    await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, 'co-owner@takeover.test')`, [CO]);
    await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [CO, STORE_A]);
    const owner = await createAdminSession(OWNER_A);
    expect((await call('POST', `/v1/admin/staff/${CO}/revoke-sessions`, { token: owner, slug: 'takeover-a' })).status).toBe(200);
    expect((await call('POST', `/v1/admin/staff/${STAFF_A}/revoke-sessions`, { token: manager, slug: 'takeover-a' })).status).toBe(200);
  });

  it('cross store: an owner of store A cannot sign out (globally) an admin who also owns store B or administers the installation', async () => {
    await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'staff')`, [OWNER_B, STORE_A]);
    const ownerA = await createAdminSession(OWNER_A);
    const victim = await createAdminSession(OWNER_B);
    const res = await call('POST', `/v1/admin/staff/${OWNER_B}/revoke-sessions`, { token: ownerA, slug: 'takeover-a' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REVOKE_REQUIRES_INSTALLATION_ADMIN');
    expect((await call('GET', '/v1/admin/me', { token: victim })).status).toBe(200);
    // an installation administrator may
    await pool.query('UPDATE admin_user SET is_installation_admin = true WHERE id = $1', [OWNER_A]);
    const install = await createAdminSession(OWNER_A);
    expect((await call('POST', `/v1/admin/staff/${OWNER_B}/revoke-sessions`, { token: install, slug: 'takeover-a' })).status).toBe(200);
    expect((await call('GET', '/v1/admin/me', { token: victim })).status).toBe(401);
  });

  it('POST /v1/admin/staff never enrols an EXISTING account that is not in this store (it must accept an invite)', async () => {
    const owner = await createAdminSession(OWNER_A);
    const res = await call('POST', '/v1/admin/staff', { token: owner, slug: 'takeover-a', body: { email: OWNER_B_EMAIL, role: 'staff', password: 'irrelevant-1' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('EXISTING_ACCOUNT_USE_INVITE');
    expect(await roleOf(OWNER_B, STORE_A)).toBeNull();
  });
});
