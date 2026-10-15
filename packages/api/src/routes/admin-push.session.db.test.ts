/**
 * Security plan rev 8, B2.16 "Live Activity registration accepted after logout" — confirmed at 8c752cf:
 * POST /v1/admin/logout deleted only the session (routes/admin.ts:80-82); device rows were never removed server-side,
 * and the iOS app unregisters only its alert token on sign-out (ios/.../AppSession.swift:95), so a signed-out phone
 * kept its `live_activity` push-to-start registration and kept receiving this store's Live Activities.
 * Fixed by 0099: a device row belongs to the session that registered it (ON DELETE CASCADE).
 * sellright_test only (TRUNCATEs).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';

const isTestDb = /^\/[^/]*_test$/.test(new URL(process.env.DATABASE_URL ?? env.DATABASE_URL).pathname);
const STORE = 'de51ce00-0000-4000-8000-000000000001';
const ADMIN = 'de51ce00-0000-4000-8000-0000000000a1';
const app = createApp();
const T = (n: number) => `${'a'.repeat(40)}${n}`;

const register = (token: string, device: string, kind: 'apns' | 'live_activity') =>
  app.request('/v1/admin/devices', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-store-slug': 'devices', 'content-type': 'application/json' }, body: JSON.stringify({ token: device, kind }) });
const devices = async () => (await pool.query('SELECT token, kind FROM admin_device_token WHERE admin_user_id = $1 ORDER BY token', [ADMIN])).rows as Array<{ token: string; kind: string }>;

beforeEach(async () => {
  if (!isTestDb) return;
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'devices', 'D', 'USD')`, [STORE]);
  await pool.query(`INSERT INTO admin_user (id, email, password_hash) VALUES ($1, 'phone@devices.test', 'x')`, [ADMIN]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'manager')`, [ADMIN, STORE]);
});
afterAll(async () => { if (isTestDb) { await pool.query('TRUNCATE store CASCADE'); await pool.query('DELETE FROM admin_user'); } await pool.end(); });

describe.skipIf(!isTestDb)('device registrations follow the session (B2.16)', () => {
  it('logout removes BOTH the alert and the Live Activity registration of that session, and nothing else', async () => {
    const phone = await createAdminSession(ADMIN);
    const tablet = await createAdminSession(ADMIN);
    expect((await register(phone, T(1), 'apns')).status).toBe(200);
    expect((await register(phone, T(2), 'live_activity')).status).toBe(200);
    expect((await register(tablet, T(3), 'live_activity')).status).toBe(200);
    const out = await app.request('/v1/admin/logout', { method: 'POST', headers: { authorization: `Bearer ${phone}` } });
    expect(out.status).toBe(200);
    expect((await devices()).map((d) => d.token)).toEqual([T(3)]);
  });

  it('a registration after logout is refused (the session is gone)', async () => {
    const phone = await createAdminSession(ADMIN);
    await app.request('/v1/admin/logout', { method: 'POST', headers: { authorization: `Bearer ${phone}` } });
    expect((await register(phone, T(4), 'live_activity')).status).toBe(401);
    expect(await devices()).toEqual([]);
  });

  it('revoking an admin\'s sessions also drops their device registrations', async () => {
    const phone = await createAdminSession(ADMIN);
    await register(phone, T(5), 'live_activity');
    await pool.query('DELETE FROM "session" WHERE admin_user_id = $1', [ADMIN]);
    expect(await devices()).toEqual([]);
  });
});
