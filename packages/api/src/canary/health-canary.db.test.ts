/**
 * DB tests for the health canary (PLAN 7.16, I-8). Runs against defork_canary_test only.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { hashPassword } from '../auth/password.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { adminSystem } from '../routes/admin-system.js';
import { emitEvent } from '../webhooks/emit.js';
import { enqueuePush } from '../push/outbox.js';
import { enqueueEmail } from '../email/outbox.js';
import { emitHealthCanary, canaryRetryAfter } from './health-canary.js';
import { CANARY_MARKER, CANARY_TOPIC, ReservedMarkerError } from './marker.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'health-canary.db.test.ts');

const STORE = 'cccccccc-0000-0000-0000-00000000c001';
const SLUG = 'health-canary-test-store';
const INSTALL = 'cccccccc-0000-0000-0000-00000000c002';
const OWNER = 'cccccccc-0000-0000-0000-00000000c003';
const PASSWORD = 'correct horse battery staple';
const CANARY_EMAIL = 'canary-mailbox@monitor.example';
const CANARY_HOOK = 'https://canary-hook.example/health';
const PUBLIC_IP = async () => [{ address: '93.184.216.34', family: 4 }];

const app = new OpenAPIHono();
app.route('/', adminSystem);

const CONFIG = {
  health: { canary: { email: CANARY_EMAIL, webhookUrl: CANARY_HOOK, pushToken: 'canary-push-token', pushEnvironment: 'sandbox' } },
};


/** Store-scoped read/write: the app role is RLS-bound, so every table query
 *  runs inside a store context (app.current_store), like production code. */
async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_store', $1, true)", [STORE]);
    const r = await c.query(text, params);
    await c.query('COMMIT');
    return { rows: r.rows as T[] };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
  // Postgres-backed rate limiter: a prior run's canary emits must not leak a 429 into this one.
  await pool.query('DELETE FROM rate_limit_attempt');
}

async function seed(config: Record<string, unknown> = CONFIG) {
  const hash = await hashPassword(PASSWORD);
  await q(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, 'Health Canary Store', 'USD', $3::jsonb)`, [STORE, SLUG, JSON.stringify(config)]);
  await q(`INSERT INTO admin_user (id, email, password_hash, is_installation_admin) VALUES ($1, 'install@canary.test', $2, true)`, [INSTALL, hash]);
  await q(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [INSTALL, STORE]);
  await q(`INSERT INTO admin_user (id, email, password_hash) VALUES ($1, 'owner@canary.test', $2)`, [OWNER, hash]);
  await q(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [OWNER, STORE]);
  return { installToken: await createAdminSession(INSTALL), ownerToken: await createAdminSession(OWNER) };
}

async function addEndpoint(url: string, topics: string[]): Promise<string> {
  const { rows } = await q<{ id: string }>(
    `INSERT INTO webhook_endpoint (store_id, url, topics, secret) VALUES ($1, $2, $3, 'secret') RETURNING id`,
    [STORE, url, topics],
  );
  return rows[0]!.id;
}

async function count(table: string, where = 'true'): Promise<number> {
  const { rows } = await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE store_id = $1 AND ${where}`, [STORE]);
  return Number(rows[0]!.n);
}

function req(token: string, body: Record<string, unknown>) {
  return app.request('/v1/admin/system/canary', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('emitHealthCanary (core)', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('renders each email kind through the real outbox with canary markers, addressed only to the canary mailbox', async () => {
    await seed();
    const result = await emitHealthCanary(STORE, { slot: 7, channels: ['email'] });
    expect(result.rows).toHaveLength(4);
    expect(result.skipped).toEqual([]);
    const { rows } = await q<{ kind: string; recipient: string; payload: { canary?: boolean; marker?: string; subject?: string; html?: string } }>(
      `SELECT kind, recipient, payload FROM email_outbox WHERE store_id = $1 ORDER BY kind`, [STORE],
    );
    expect(rows.map((r) => r.kind).sort()).toEqual(['order_confirmation', 'password_reset', 'shipping_notification', 'trial_license_key']);
    for (const r of rows) {
      expect(r.recipient).toBe(CANARY_EMAIL);
      expect(r.payload.canary).toBe(true);
      expect(r.payload.marker).toBe(CANARY_MARKER);
      expect(r.payload.subject?.length).toBeGreaterThan(0);
      expect(r.payload.html).toContain('Health Canary Store');
    }
    expect(result.rows.every((r) => r.channel === 'email' && typeof r.id === 'string' && r.id.length > 0)).toBe(true);
  });

  it('honours an explicit kinds subset', async () => {
    await seed();
    const result = await emitHealthCanary(STORE, { slot: 1, channels: ['email'], kinds: ['password_reset'] });
    expect(result.rows.map((r) => r.kind)).toEqual(['password_reset']);
    expect(await count('email_outbox')).toBe(1);
  });

  it('webhook canary goes to the canary endpoint only; merchant subscriptions never receive health.canary', async () => {
    await seed();
    const wildcard = await addEndpoint('https://merchant-all.example/hook', ['*']);
    const paid = await addEndpoint('https://merchant-paid.example/hook', ['order.paid']);
    const result = await emitHealthCanary(STORE, { slot: 3, channels: ['webhook'] }, { lookup: PUBLIC_IP });
    expect(result.rows).toHaveLength(1);
    const { rows } = await q<{ endpoint_id: string; topic: string; payload: { canary?: boolean; marker?: string; slot?: number } }>(
      `SELECT wd.endpoint_id, wd.topic, wd.payload FROM webhook_delivery wd WHERE wd.store_id = $1`, [STORE],
    );
    expect(rows).toHaveLength(1);
    const canaryEp = await q<{ id: string; topics: string[]; url: string }>(`SELECT id, topics, url FROM webhook_endpoint WHERE id = $1`, [rows[0]!.endpoint_id]);
    expect(canaryEp.rows[0]!.topics).toEqual([CANARY_TOPIC]);
    expect(canaryEp.rows[0]!.url).toBe(CANARY_HOOK);
    expect(rows[0]!.topic).toBe(CANARY_TOPIC);
    expect(rows[0]!.payload.canary).toBe(true);
    expect(rows[0]!.payload.marker).toBe(CANARY_MARKER);
    expect(rows[0]!.payload.slot).toBe(3);

    // A real order event fans out to merchant subscriptions and never to the canary endpoint.
    await withStore(STORE, (tx) => emitEvent(tx, STORE, 'order.paid', { code: 'REAL-1' }));
    const real = await q<{ endpoint_id: string; topic: string }>(`SELECT endpoint_id, topic FROM webhook_delivery WHERE store_id = $1 AND topic = 'order.paid' ORDER BY endpoint_id`, [STORE]);
    expect(real.rows.map((r) => r.endpoint_id).sort()).toEqual([wildcard, paid].sort());
    expect(real.rows.some((r) => r.endpoint_id === canaryEp.rows[0]!.id)).toBe(false);
  });

  it('a second canary to the same URL reuses the canary endpoint', async () => {
    await seed();
    await emitHealthCanary(STORE, { slot: 1, channels: ['webhook'] }, { lookup: PUBLIC_IP });
    await emitHealthCanary(STORE, { slot: 2, channels: ['webhook'] }, { lookup: PUBLIC_IP });
    expect(await count('webhook_endpoint', `topics = ARRAY['health.canary']::text[]`)).toBe(1);
    expect(await count('webhook_delivery')).toBe(2);
  });

  it('push canary targets only the configured test token, never registered devices', async () => {
    await seed();
    const adminUser = '99999999-0000-0000-0000-00000000c004';
    await q(`INSERT INTO admin_user (id, email, password_hash) VALUES ($1, 'phone@canary.test', 'x')`, [adminUser]);
    await q(`INSERT INTO admin_device_token (store_id, admin_user_id, token, kind, environment, topics) VALUES ($1, $2, 'real-device', 'apns', 'production', ARRAY['*'])`, [STORE, adminUser]);
    const result = await emitHealthCanary(STORE, { slot: 4, channels: ['push'] }, { pushEnabled: true });
    expect(result.rows.map((r) => r.channel)).toEqual(['push']);
    const { rows } = await q<{ topic: string; device_token: string; environment: string; payload: { canary?: boolean; marker?: string } }>(
      `SELECT topic, device_token, environment, payload FROM push_outbox WHERE store_id = $1`, [STORE],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.topic).toBe(CANARY_TOPIC);
    expect(rows[0]!.device_token).toBe('canary-push-token');
    expect(rows[0]!.environment).toBe('sandbox');
    expect(rows[0]!.payload.canary).toBe(true);
    expect(rows[0]!.payload.marker).toBe(CANARY_MARKER);
  });

  it('push is skipped as N/A while push jobs are disabled', async () => {
    await seed();
    const result = await emitHealthCanary(STORE, { slot: 5, channels: ['push'] }, { pushEnabled: false });
    expect(result.rows).toEqual([]);
    expect(result.skipped).toEqual([{ channel: 'push', reason: 'push_jobs_disabled' }]);
    expect(await count('push_outbox')).toBe(0);
  });

  it('refuses before inserting anything when a recipient is missing or the webhook URL is unsafe', async () => {
    await seed({ health: { canary: { webhookUrl: CANARY_HOOK } } });
    await expect(emitHealthCanary(STORE, { slot: 1, channels: ['email', 'webhook'] }, { lookup: PUBLIC_IP })).rejects.toMatchObject({ code: 'canary_email_not_configured', status: 422 });
    expect(await count('email_outbox')).toBe(0);
    expect(await count('webhook_delivery')).toBe(0);

    await q(`UPDATE store SET config = $2::jsonb WHERE id = $1`, [STORE, JSON.stringify({ health: { canary: { email: CANARY_EMAIL, webhookUrl: 'http://127.0.0.1/hook' } } })]);
    await expect(emitHealthCanary(STORE, { slot: 1, channels: ['email', 'webhook'] })).rejects.toMatchObject({ code: 'canary_webhook_url_unsafe', status: 422 });
    expect(await count('email_outbox')).toBe(0);
  });

  it('public enqueue paths refuse marker payloads and the reserved topic', async () => {
    await seed();
    await expect(withStore(STORE, (tx) => enqueueEmail(tx, STORE, {
      kind: 'contact_ack', recipient: 'a@b.test', payload: { to: 'a@b.test', subject: 's', html: 'h', text: 't', canary: true } as never,
    }))).rejects.toBeInstanceOf(ReservedMarkerError);
    await expect(withStore(STORE, (tx) => enqueuePush(tx, STORE, { topic: CANARY_TOPIC, payload: {} }))).rejects.toBeInstanceOf(ReservedMarkerError);
    await expect(withStore(STORE, (tx) => emitEvent(tx, STORE, CANARY_TOPIC, {}))).rejects.toBeInstanceOf(ReservedMarkerError);
    expect(await count('email_outbox')).toBe(0);
  });

  it('core emitter does not consume the route rate budget', async () => {
    await seed();
    await emitHealthCanary(STORE, { slot: 1, channels: ['email'], kinds: ['password_reset'] });
    expect(await canaryRetryAfter(STORE, ['email'])).toBe(0);
  });
});

describe('POST /v1/admin/system/canary (route)', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('installation admin enqueues; owner-only is forbidden; second emit inside a minute is 429', async () => {
    const { installToken, ownerToken } = await seed();

    const forbidden = await req(ownerToken, { slot: 1, channels: ['email'] });
    expect(forbidden.status).toBe(403);
    expect(await count('email_outbox')).toBe(0);

    const ok = await req(installToken, { slot: 9, channels: ['email'], kinds: ['order_confirmation'] });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { slot: number; rows: Array<{ channel: string; kind: string; id: string }> };
    expect(body.slot).toBe(9);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.kind).toBe('order_confirmation');

    const limited = await req(installToken, { slot: 10, channels: ['email'] });
    expect(limited.status).toBe(429);
    const limitedBody = await limited.json() as { error: { code?: string; extra?: unknown } | string };
    expect(JSON.stringify(limitedBody)).toContain('canary_rate_limited');
    expect(await count('email_outbox')).toBe(1);
  });

  it('refuses an unknown channel and kinds without email', async () => {
    const { installToken } = await seed();
    expect((await req(installToken, { slot: 1, channels: ['sms'] })).status).toBeGreaterThanOrEqual(400);
    expect((await req(installToken, { slot: 1, channels: ['push'], kinds: ['password_reset'] })).status).toBe(422);
    expect(await count('email_outbox')).toBe(0);
  });
});

