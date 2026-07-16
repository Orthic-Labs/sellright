/**
 * DB tests — push outbox (0039). Mirrors admin-orders.refund.test.ts: real Hono
 * handlers via app.request(), real DB, sellright_test only.
 *
 * APNs is mocked at the module boundary (./apns.js) so no HTTP/2 socket opens
 * and we can drive the exact responses that matter: 200, a retryable 500, and
 * 410 Unregistered (the one with a side effect — token deletion).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const apnsCalls: Array<{ deviceToken: string; environment: string }> = [];
let apnsImpl = async (_args: { deviceToken: string; environment: string }) => ({
  ok: true, status: 200, unregistered: false, reason: undefined as string | undefined,
});

vi.mock('./apns.js', async (orig) => {
  const actual = await orig<typeof import('./apns.js')>();
  return {
    ...actual,
    apnsConfigured: () => true,
    sendApns: async (args: { deviceToken: string; environment: string }) => {
      apnsCalls.push({ deviceToken: args.deviceToken, environment: args.environment });
      return apnsImpl(args);
    },
  };
});

import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminPush } from '../routes/admin-push.js';
import { enqueuePush, buildOrderPushPayload, deliverPushes } from './outbox.js';

if (!/_test(\b|$)/.test(new URL(env.DATABASE_URL).pathname)) {
  throw new Error('refusing to run: DATABASE_URL must point at a _test database');
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SLUG = 'push-test-store';
const ADMIN = 'eeeeeeee-eeee-eeee-eeee-00000000000a';
const OTHER_ADMIN = 'eeeeeeee-eeee-eeee-eeee-00000000000b';

const app = new OpenAPIHono();
app.route('/', adminPush);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<string> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, 'Push Test', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [STORE, SLUG],
  );
  for (const id of [ADMIN, OTHER_ADMIN]) {
    await pool.query(
      `INSERT INTO admin_user (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [id, `${id}@push.test`],
    );
    await pool.query(
      `INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT DO NOTHING`,
      [id, STORE],
    );
  }
  return createAdminSession(ADMIN);
}

function register(token: string, body: Record<string, unknown>) {
  return app.request('/v1/admin/devices', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function tokenRows(): Promise<Array<{ token: string; admin_user_id: string }>> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT token, admin_user_id FROM admin_device_token ORDER BY token`);
    return r.rows as Array<{ token: string; admin_user_id: string }>;
  });
}

async function outboxRows(): Promise<Array<{ status: string; attempts: number }>> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT status, attempts FROM push_outbox`);
    return r.rows as Array<{ status: string; attempts: number }>;
  });
}

const DEVICE_A = 'a'.repeat(64);
const DEVICE_B = 'b'.repeat(64);

let session = '';
beforeEach(async () => {
  await wipe();
  apnsCalls.length = 0;
  apnsImpl = async () => ({ ok: true, status: 200, unregistered: false, reason: undefined });
  session = await seed();
});
afterAll(async () => { await wipe(); });

describe('POST /v1/admin/devices', () => {
  it('binds the token to the authenticated admin, and re-registering rebinds rather than duplicating', async () => {
    expect((await register(session, { token: DEVICE_A })).status).toBe(200);
    expect(await tokenRows()).toEqual([{ token: DEVICE_A, admin_user_id: ADMIN }]);

    // Same physical device, different operator signs in. One row, new owner —
    // the previous operator must stop receiving this store's alerts.
    const otherSession = await createAdminSession(OTHER_ADMIN);
    expect((await register(otherSession, { token: DEVICE_A })).status).toBe(200);
    expect(await tokenRows()).toEqual([{ token: DEVICE_A, admin_user_id: OTHER_ADMIN }]);
  });

  it('rejects an unauthenticated registration', async () => {
    const res = await app.request('/v1/admin/devices', {
      method: 'POST',
      headers: { 'x-store-slug': SLUG, 'content-type': 'application/json' },
      body: JSON.stringify({ token: DEVICE_A }),
    });
    expect(res.status).toBe(401);
    expect(await tokenRows()).toHaveLength(0);
  });
});

describe('DELETE /v1/admin/devices/{token}', () => {
  it("deletes only the caller's own token, never another admin's", async () => {
    await register(session, { token: DEVICE_A });
    const otherSession = await createAdminSession(OTHER_ADMIN);
    await register(otherSession, { token: DEVICE_B });

    // ADMIN tries to unregister OTHER_ADMIN's device: 200 (idempotent), but the
    // row must survive — logout must not be a way to silence a colleague.
    const res = await app.request(`/v1/admin/devices/${DEVICE_B}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session}`, 'x-store-slug': SLUG },
    });
    expect(res.status).toBe(200);
    expect((await tokenRows()).map((r) => r.token)).toContain(DEVICE_B);

    // Its own token does go.
    await app.request(`/v1/admin/devices/${DEVICE_A}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session}`, 'x-store-slug': SLUG },
    });
    expect((await tokenRows()).map((r) => r.token)).toEqual([DEVICE_B]);
  });
});

describe('enqueuePush + deliverPushes', () => {
  const payload = () => buildOrderPushPayload({ topic: 'order.paid', code: 'SR-1', grandTotal: 2500, currency: 'USD' });

  it('fans out one row per subscribed device and delivers them', async () => {
    await register(session, { token: DEVICE_A });
    await register(await createAdminSession(OTHER_ADMIN), { token: DEVICE_B });

    const queued = await withStore(STORE, (tx) => enqueuePush(tx, STORE, { topic: 'order.paid', payload: payload() }));
    expect(queued).toBe(2);

    const res = await deliverPushes({});
    expect(res.sent).toBe(2);
    expect(apnsCalls.map((c) => c.deviceToken).sort()).toEqual([DEVICE_A, DEVICE_B]);
    expect((await outboxRows()).every((r) => r.status === 'sent')).toBe(true);
  });

  it('does not enqueue for a device not subscribed to the topic', async () => {
    await register(session, { token: DEVICE_A, topics: ['order.shipped'] });
    const queued = await withStore(STORE, (tx) => enqueuePush(tx, STORE, { topic: 'order.paid', payload: payload() }));
    expect(queued).toBe(0);
  });

  it('honors the sandbox environment reported at registration', async () => {
    await register(session, { token: DEVICE_A, environment: 'sandbox' });
    await withStore(STORE, (tx) => enqueuePush(tx, STORE, { topic: 'order.paid', payload: payload() }));
    await deliverPushes({});
    expect(apnsCalls[0]!.environment).toBe('sandbox');
  });

  it('410 Unregistered deletes the device token and dead-letters the row instead of retrying', async () => {
    await register(session, { token: DEVICE_A });
    apnsImpl = async () => ({ ok: false, status: 410, unregistered: true, reason: 'Unregistered' });

    await withStore(STORE, (tx) => enqueuePush(tx, STORE, { topic: 'order.paid', payload: payload() }));
    const res = await deliverPushes({});

    expect(res.pruned).toBe(1);
    expect(await tokenRows()).toHaveLength(0);
    expect(await outboxRows()).toEqual([{ status: 'dead', attempts: 1 }]);

    // The dead token is gone, so a later event queues nothing for it.
    const queued = await withStore(STORE, (tx) => enqueuePush(tx, STORE, { topic: 'order.paid', payload: payload() }));
    expect(queued).toBe(0);
  });

  it('a transient APNs failure keeps the row pending for retry and keeps the token', async () => {
    await register(session, { token: DEVICE_A });
    apnsImpl = async () => ({ ok: false, status: 500, unregistered: false, reason: 'InternalServerError' });

    await withStore(STORE, (tx) => enqueuePush(tx, STORE, { topic: 'order.paid', payload: payload() }));
    const res = await deliverPushes({});

    expect(res.failed).toBe(1);
    expect(res.pruned).toBe(0);
    expect(await outboxRows()).toEqual([{ status: 'pending', attempts: 1 }]);
    expect(await tokenRows()).toHaveLength(1);
  });
});

describe('buildOrderPushPayload', () => {
  it('formats cents as currency in the alert body and carries the deep-link code', () => {
    const p = buildOrderPushPayload({ topic: 'order.paid', code: 'SR-1042', grandTotal: 15900, currency: 'USD' }) as {
      aps: { alert: { title: string; body: string }; sound: string };
      orderCode: string;
    };
    expect(p.aps.alert.title).toBe('New order');
    expect(p.aps.alert.body).toContain('SR-1042');
    expect(p.aps.alert.body).toContain('159.00');
    expect(p.aps.sound).toBe('default');
    expect(p.orderCode).toBe('SR-1042');
  });
});
