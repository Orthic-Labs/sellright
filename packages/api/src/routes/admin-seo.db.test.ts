/**
 * SEO-1 admin surface DB tests: GET/PATCH /v1/admin/seo/config (role gating,
 * persistence, audit trail) and POST /v1/admin/seo/indexnow/submit
 * (admin-triggered, no-op-without-a-key, mocked outbound call). Mirrors
 * admin-settings-audit.db.test.ts's seeding + request-helper style.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { adminSeo } from './admin-seo.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-seo.db.test.ts');

// UUID segments must be valid hex — no 's' (use '5e..' in place of 'se..').
const STORE = 'eeeeeeee-0000-0000-0000-0000000005e1';
const SLUG = 'admin-seo-test-store';
const OWNER = 'eeeeeeee-0000-0000-0000-0000000005e2';
const MANAGER = 'eeeeeeee-0000-0000-0000-0000000005e3';
const STAFF = 'eeeeeeee-0000-0000-0000-0000000005e4';

const app = new OpenAPIHono();
app.route('/', adminSeo);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seedAdmin(id: string, email: string, role: string) {
  await pool.query(`INSERT INTO admin_user (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, email]);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, STORE, role]);
}

async function seed(): Promise<{ ownerToken: string; managerToken: string; staffToken: string }> {
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, 'Admin SEO Test Store', 'USD') ON CONFLICT (id) DO NOTHING`, [STORE, SLUG]);
  await seedAdmin(OWNER, 'owner@adminseo.test', 'owner');
  await seedAdmin(MANAGER, 'manager@adminseo.test', 'manager');
  await seedAdmin(STAFF, 'staff@adminseo.test', 'staff');
  return { ownerToken: await createAdminSession(OWNER), managerToken: await createAdminSession(MANAGER), staffToken: await createAdminSession(STAFF) };
}

function req(token: string, method: string, path: string, body?: Record<string, unknown>) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET/PATCH /v1/admin/seo/config', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('any store-scoped role can view the effective config; defaults when unconfigured', async () => {
    const { staffToken } = await seed();
    const res = await req(staffToken, 'GET', '/v1/admin/seo/config');
    expect(res.status).toBe(200);
    const body = await res.json() as { siteUrl: string | null; indexNowConfigured: boolean; robotsDisallow: string[] };
    expect(body.siteUrl).toBeNull();
    expect(body.indexNowConfigured).toBe(false);
    expect(body.robotsDisallow).toContain('checkout');
  });

  it('staff cannot PATCH (requireManage); manager and owner can', async () => {
    const { ownerToken, managerToken, staffToken } = await seed();
    const denied = await req(staffToken, 'PATCH', '/v1/admin/seo/config', { siteUrl: 'https://example.com' });
    expect(denied.status).toBe(403);

    const ok = await req(managerToken, 'PATCH', '/v1/admin/seo/config', { siteUrl: 'https://example.com', contactEmail: 'hi@example.com' });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { siteUrl: string; contactEmail: string };
    expect(body.siteUrl).toBe('https://example.com');
    expect(body.contactEmail).toBe('hi@example.com');

    const ownerPatch = await req(ownerToken, 'PATCH', '/v1/admin/seo/config', { organization: { name: 'Acme' } });
    expect(ownerPatch.status).toBe(200);
  });

  it('PATCH persists and a subsequent GET reflects it', async () => {
    const { managerToken } = await seed();
    await req(managerToken, 'PATCH', '/v1/admin/seo/config', { siteUrl: 'https://persisted.example.com', robotsDisallow: ['custom-path'] });
    const body = await (await req(managerToken, 'GET', '/v1/admin/seo/config')).json() as { siteUrl: string; robotsDisallow: string[] };
    expect(body.siteUrl).toBe('https://persisted.example.com');
    expect(body.robotsDisallow).toEqual(['custom-path']);
  });

  it('records a durable, secret-free audit_log row on every PATCH', async () => {
    const { managerToken } = await seed();
    await req(managerToken, 'PATCH', '/v1/admin/seo/config', { siteUrl: 'https://audited.example.com' });
    // audit_log is FORCE-RLS'd (unlike `store`, the un-RLS'd tenant registry —
    // see store-context.ts) — a read needs app.current_store set, so this
    // goes through withStore exactly like admin-settings-audit.db.test.ts's
    // auditRows() helper, not a bare pool.query.
    const rows = await withStore(STORE, (tx) =>
      tx.execute(sql`SELECT actor, action, to_state AS "toState" FROM audit_log WHERE store_id = ${STORE} AND action = 'seo_config_updated'`),
    ).then((r) => r.rows as Array<{ actor: string; action: string; toState: string }>);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('manager@adminseo.test');
    expect(JSON.parse(rows[0]!.toState)).toMatchObject({ siteUrl: 'https://audited.example.com' });
  });

  it('rejects an invalid siteUrl / IndexNow key shape at the schema layer', async () => {
    const { managerToken } = await seed();
    expect((await req(managerToken, 'PATCH', '/v1/admin/seo/config', { siteUrl: 'not-a-url' })).status).toBe(400);
    expect((await req(managerToken, 'PATCH', '/v1/admin/seo/config', { indexNowKey: 'zz' })).status).toBe(400);
  });
});

describe('POST /v1/admin/seo/indexnow/submit', () => {
  beforeEach(wipe);
  afterEach(() => vi.unstubAllGlobals());
  afterAll(wipe);

  it('409s (no outbound call) when the store has no IndexNow key configured', async () => {
    const { managerToken } = await seed();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await req(managerToken, 'POST', '/v1/admin/seo/indexnow/submit', { urls: ['https://example.com/products/widget/'] });
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('staff (write role) can trigger a submit once a key is configured, and the outbound call is made', async () => {
    const { managerToken, staffToken } = await seed();
    await req(managerToken, 'PATCH', '/v1/admin/seo/config', { siteUrl: 'https://example.com', indexNowKey: 'abcdef0123456789' });

    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await req(staffToken, 'POST', '/v1/admin/seo/indexnow/submit', { urls: ['https://example.com/products/widget/'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 202 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.indexnow.org/indexnow');
  });
});
