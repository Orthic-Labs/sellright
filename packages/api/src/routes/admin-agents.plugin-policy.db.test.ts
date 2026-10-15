/**
 * P1c (security audit 2026-10-15): agent seats vs plugin admin routes, webhook endpoints, token expiry.
 * Real app + real DB (sellright_test ONLY — TRUNCATEs).
 *  - A plugin admin MUTATION is denied to agents unless the plugin allowlists it (default-deny), and plugins can
 *    extend the deny map with their own groups. Built-in engine routes are unaffected.
 *  - Webhook create/patch are in the credentials deny group (they mint a signing secret / redirect store data).
 *  - Agent tokens get a default expiry (ADMIN_AGENT_TOKEN_TTL_DAYS, default 90).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { buildAgentRouteContext } from '../auth/agent-policy.js';
import { buildHttpApp } from '../app.js';
import { _clearApiPluginsForTest, registerApiPlugin } from '../plugins.js';
import { requireAdmin, requireStore } from './admin-helpers.js';

const isTestDb = /^\/[^/]*_test$/.test(new URL(process.env.DATABASE_URL ?? env.DATABASE_URL).pathname);
const STORE = 'acacacac-acac-4cac-8cac-acacacacac01';
const MANAGER = 'acacacac-acac-4cac-8cac-0000000000b1';

function pluginRoutes() {
  const r = new OpenAPIHono();
  for (const p of ['/v1/admin/plugin-x/unreviewed', '/v1/admin/plugin-x/reviewed', '/v1/admin/plugin-x/kill']) {
    r.post(p, async (c) => { const { admin } = await requireAdmin(c); requireStore(admin, c); return c.json({ ok: true }); });
  }
  r.get('/v1/admin/plugin-x/read', async (c) => { await requireAdmin(c); return c.json({ ok: true }); });
  return r;
}

let app: ReturnType<typeof buildHttpApp>;
let manager = '';
const call = (method: string, path: string, token: string, body?: unknown) =>
  app.request(path, { method, headers: { authorization: `Bearer ${token}`, 'x-store-slug': 'plugin-policy', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_api_token');
  await pool.query('DELETE FROM admin_user');
}

beforeAll(() => {
  _clearApiPluginsForTest();
  registerApiPlugin({
    name: 'plugin-x',
    routes: pluginRoutes(),
    agentPolicy: { allow: ['POST /v1/admin/plugin-x/reviewed'], deny: { 'POST /v1/admin/plugin-x/kill': 'entitlement' } },
  });
  app = buildHttpApp();
});
beforeEach(async () => {
  if (!isTestDb) return;
  await wipe();
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'plugin-policy', 'P', 'USD')`, [STORE]);
  await pool.query(`INSERT INTO admin_user (id, email, password_hash) VALUES ($1, 'manager@plugin-policy.test', 'x')`, [MANAGER]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'manager')`, [MANAGER, STORE]);
  manager = await createAdminSession(MANAGER);
});
afterAll(async () => { _clearApiPluginsForTest(); if (isTestDb) await wipe(); await pool.end(); });

async function agentToken(extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/v1/admin/agents', manager, { name: 'Bot', role: 'manager', ...extra });
  expect(r.status).toBe(200);
  return (await r.json()) as { token: string; adminUserId: string };
}

describe.skipIf(!isTestDb)('P1c: plugin admin routes are default-deny for agents', () => {
  it('an unlisted plugin mutation is refused to an agent (403 AGENT_NOT_ALLOWED) but still works for a human', async () => {
    const { token } = await agentToken();
    const res = await call('POST', '/v1/admin/plugin-x/unreviewed', token);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AGENT_NOT_ALLOWED');
    expect((await call('POST', '/v1/admin/plugin-x/unreviewed', manager)).status).toBe(200);
  });

  it('a plugin can allowlist a reviewed mutation and extend the deny map with its own group', async () => {
    const { token } = await agentToken();
    expect((await call('POST', '/v1/admin/plugin-x/reviewed', token)).status).toBe(200);
    const kill = await call('POST', '/v1/admin/plugin-x/kill', token);
    expect(kill.status).toBe(403);
    expect(((await kill.json()) as { error: { message: string } }).error.message).toMatch(/entitlements/);
    expect((await call('GET', '/v1/admin/plugin-x/read', token)).status).toBe(200); // reads are never denied
  });

  it('a plugin cannot allowlist a route the engine denies', () => {
    expect(() => buildAgentRouteContext(new Set(), [{ name: 'evil', policy: { allow: ['POST /v1/admin/staff/invites'] } }])).toThrow(/deny list/);
  });
});

describe.skipIf(!isTestDb)('P1c: webhooks and token expiry', () => {
  it('agents cannot create or repoint webhook endpoints', async () => {
    const { token } = await agentToken();
    expect((await call('POST', '/v1/admin/webhooks', token, { url: 'https://hooks.example.net/x', topics: ['order.paid'] })).status).toBe(403);
    expect((await call('PATCH', '/v1/admin/webhooks/00000000-0000-4000-8000-000000000000', token, { url: 'https://evil.example.net/x' })).status).toBe(403);
  });

  it('a token created without an expiry expires after the default TTL', async () => {
    await agentToken();
    const { rows } = await pool.query('SELECT expires_at FROM admin_api_token');
    const days = (new Date(rows[0].expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(env.ADMIN_AGENT_TOKEN_TTL_DAYS - 1);
    expect(days).toBeLessThanOrEqual(env.ADMIN_AGENT_TOKEN_TTL_DAYS);
  });
});
