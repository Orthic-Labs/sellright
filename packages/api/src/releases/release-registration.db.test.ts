/**
 * DB tests for the engine-hosted release registration policy (defork 3.2).
 * Drives POST /v1/admin/apps/releases through the real handler with seeded
 * admin sessions and a plugin-supplied policy. *_test database ONLY (TRUNCATEs).
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { invalidateStoreCache } from '../store-context.js';
import { _clearApiPluginsForTest, registerApiPlugin, type ApiPlugin } from '../plugins.js';
import { createApp } from '../app.js';
import { releaseRegistrationRoutes } from './release-registration.js';
import type { ReleaseRegistrationBody } from './registration-policy.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error('release-registration test truncates data — point DATABASE_URL at a *_test database');
}

const STORE_A = 'abababab-abab-abab-abab-abababababa1';
const STORE_B = 'abababab-abab-abab-abab-abababababb2';
const SLUG_A = 'rel-reg-a';
const SLUG_B = 'rel-reg-b';
const OWNER = 'abababab-abab-abab-abab-00000000000a';
const STAFF = 'abababab-abab-abab-abab-00000000000b';
const TOKEN = 'release-token-for-tenant-a';
const TOKEN_SHA = createHash('sha256').update(TOKEN).digest('hex');
const OTHER_TOKEN_SHA = createHash('sha256').update('other-token').digest('hex');

const app = new OpenAPIHono();
app.route('/', releaseRegistrationRoutes);

/** Emulates the fork's validateReleaseRegistration(body,'update',KEYS): darwin|windows only, stable only, manifest.version must match. */
function forkLikeValidate(body: ReleaseRegistrationBody): ReleaseRegistrationBody {
  if (body.platform !== 'darwin' && body.platform !== 'windows') throw new Error('platform');
  if (body.channel !== 'stable') throw new Error('channel');
  if ((body.manifest as { version?: string }).version !== body.version) throw new Error('manifest version mismatch');
  if (!body.artifactManifest) throw new Error('artifactManifest required');
  return body;
}

function policyPlugin(over: Partial<ApiPlugin> & { name?: string } = {}): ApiPlugin {
  return {
    name: over.name ?? 'suite',
    releaseRegistration: over.releaseRegistration ?? {
      apps: ['suite-app'],
      channels: ['stable'],
      serviceCredential: { sha256: TOKEN_SHA, storeSlug: SLUG_A },
      validate: forkLikeValidate,
    },
    ...(over.routes ? { routes: over.routes } : {}),
  };
}

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed() {
  await withStore(STORE_A, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE_A}, ${SLUG_A}, ${SLUG_A}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE_B}, ${SLUG_B}, ${SLUG_B}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${OWNER}, 'owner@relreg.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${STAFF}, 'staff@relreg.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${OWNER}, ${STORE_A}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role, permissions) VALUES (${STAFF}, ${STORE_A}, 'staff', '{}'::jsonb) ON CONFLICT DO NOTHING`);
  });
  return { owner: await createAdminSession(OWNER), staff: await createAdminSession(STAFF) };
}

function payload(over: Record<string, unknown> = {}) {
  return {
    appKey: 'suite-app', version: '1.2.3', channel: 'stable', platform: 'darwin',
    manifest: { version: '1.2.3', tier: 'update' },
    artifacts: [{ artifactKey: 'suite-app-mac', path: 'suite-app/updates/mac/current/a.tar.gz', sha256: 'aa', sizeBytes: 10 }],
    artifactManifest: { appKey: 'suite-app' },
    ...over,
  };
}

async function post(body: unknown, headers: Record<string, string>) {
  const res = await app.request('/v1/admin/apps/releases', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function counts(storeId = STORE_A) {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`SELECT (SELECT count(*) FROM app_release)::int AS releases, (SELECT count(*) FROM download_artifact)::int AS artifacts`);
    return r.rows[0] as { releases: number; artifacts: number };
  });
}

beforeEach(async () => { _clearApiPluginsForTest(); invalidateStoreCache(); await wipe(); });
afterEach(async () => { _clearApiPluginsForTest(); await wipe(); });
afterAll(async () => { await pool.end(); });

describe('engine default (no policy registered)', () => {
  it('admin session writes release + artifact in one request', async () => {
    const { owner } = await seed();
    const r = await post({ appKey: 'any-app', version: '1', platform: 'darwin', manifest: {}, artifacts: [{ artifactKey: 'k', path: 'p' }] },
      { authorization: `Bearer ${owner}`, 'x-store-slug': SLUG_A });
    expect(r.status).toBe(200);
    expect(await counts()).toEqual({ releases: 1, artifacts: 1 });
  });

  it('staff without the releases permission is rejected and writes nothing', async () => {
    const { staff } = await seed();
    const r = await post(payload(), { authorization: `Bearer ${staff}`, 'x-store-slug': SLUG_A });
    expect(r.status).toBe(403);
    expect(await counts()).toEqual({ releases: 0, artifacts: 0 });
  });

  it('a service-token-shaped bearer is just an invalid session (401)', async () => {
    await seed();
    const r = await post(payload(), { authorization: `Bearer ${TOKEN}`, 'x-store-slug': SLUG_A });
    expect(r.status).toBe(401);
  });
});

describe('with a plugin policy', () => {
  it('service credential publishes with default tenant (no x-store-slug header)', async () => {
    await seed();
    registerApiPlugin(policyPlugin());
    const r = await post(payload(), { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    expect(await counts()).toEqual({ releases: 1, artifacts: 1 });
  });

  it('admin session also publishes through the same hook', async () => {
    const { owner } = await seed();
    registerApiPlugin(policyPlugin());
    const r = await post(payload(), { authorization: `Bearer ${owner}`, 'x-store-slug': SLUG_A });
    expect(r.status).toBe(200);
  });

  it('wrong tenant: credential with another x-store-slug is 403 and writes nothing to either tenant', async () => {
    await seed();
    registerApiPlugin(policyPlugin());
    const r = await post(payload(), { authorization: `Bearer ${TOKEN}`, 'x-store-slug': SLUG_B });
    expect(r.status).toBe(403);
    expect(r.text).toContain(`release service token is restricted to ${SLUG_A}`);
    expect(await counts(STORE_A)).toEqual({ releases: 0, artifacts: 0 });
    expect(await counts(STORE_B)).toEqual({ releases: 0, artifacts: 0 });
  });

  it('a different (unregistered) token is rejected', async () => {
    await seed();
    registerApiPlugin(policyPlugin());
    const r = await post(payload(), { authorization: 'Bearer some-other-token', 'x-store-slug': SLUG_A });
    expect(r.status).toBe(401);
    expect(await counts()).toEqual({ releases: 0, artifacts: 0 });
  });

  it('invalid app, invalid channel and hook rejection are 400 invalid release payload with no writes', async () => {
    await seed();
    registerApiPlugin(policyPlugin());
    const h = { authorization: `Bearer ${TOKEN}` };
    for (const bad of [
      payload({ appKey: 'not-claimed' }),
      payload({ channel: 'beta' }),
      payload({ platform: null }),
      payload({ manifest: { version: '9.9.9' } }),
      payload({ artifactManifest: undefined }),
    ]) {
      const r = await post(bad, h);
      expect(r.status).toBe(400);
      expect(r.text).toContain('invalid release payload');
    }
    expect(await counts()).toEqual({ releases: 0, artifacts: 0 });
  });

  it('credential cannot publish an app claimed by a different policy', async () => {
    await seed();
    registerApiPlugin(policyPlugin());
    registerApiPlugin({ name: 'other', releaseRegistration: { apps: ['other-app'], serviceCredential: { sha256: OTHER_TOKEN_SHA, storeSlug: SLUG_A } } });
    const r = await post(payload({ appKey: 'other-app', artifactManifest: { appKey: 'other-app' } }), { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(400);
    expect(await counts()).toEqual({ releases: 0, artifacts: 0 });
  });

  it('a hook that rewrites appKey is rejected', async () => {
    await seed();
    registerApiPlugin(policyPlugin({ releaseRegistration: { apps: ['suite-app'], serviceCredential: { sha256: TOKEN_SHA, storeSlug: SLUG_A }, validate: (b) => ({ ...b, appKey: 'x' }) } }));
    const r = await post(payload(), { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(400);
  });
});

describe('same-version republish', () => {
  it('platform set + repointArtifacts: updates the same row (same id), refreshes manifest, published_at and repoints the artifact row', async () => {
    await seed();
    registerApiPlugin(policyPlugin({ releaseRegistration: { apps: ['suite-app'], repointArtifacts: true, serviceCredential: { sha256: TOKEN_SHA, storeSlug: SLUG_A }, validate: forkLikeValidate } }));
    const h = { authorization: `Bearer ${TOKEN}` };
    const first = JSON.parse((await post(payload(), h)).text) as { id: string };
    const before = await withStore(STORE_A, async (tx) => (await tx.execute(sql`SELECT published_at FROM app_release`)).rows[0] as { published_at: Date });
    await new Promise((r) => setTimeout(r, 15));
    const second = JSON.parse((await post(payload({
      manifest: { version: '1.2.3', tier: 'update', notes: 'v2' },
      artifacts: [{ artifactKey: 'suite-app-mac', path: 'new/path.tar.gz', sha256: 'bb', sizeBytes: 20 }],
    }), h)).text) as { id: string };
    expect(second.id).toBe(first.id);
    expect(await counts()).toEqual({ releases: 1, artifacts: 1 });
    const rows = await withStore(STORE_A, async (tx) => ({
      rel: (await tx.execute(sql`SELECT manifest, published_at FROM app_release`)).rows[0] as { manifest: { notes?: string }; published_at: Date },
      art: (await tx.execute(sql`SELECT path, sha256, size_bytes, app_release_id FROM download_artifact`)).rows[0] as { path: string; sha256: string; size_bytes: string; app_release_id: string },
    }));
    expect(rows.rel.manifest.notes).toBe('v2');
    expect(new Date(rows.rel.published_at).getTime()).toBeGreaterThan(new Date(before.published_at).getTime());
    expect(rows.art).toMatchObject({ path: 'new/path.tar.gz', sha256: 'bb', size_bytes: '20', app_release_id: first.id });
  });

  it('default (no repointArtifacts): same-version republish refreshes the release but keeps the existing download_artifact row (SellRight behaviour)', async () => {
    await seed();
    registerApiPlugin(policyPlugin());
    const h = { authorization: `Bearer ${TOKEN}` };
    const first = JSON.parse((await post(payload(), h)).text) as { id: string };
    const second = JSON.parse((await post(payload({
      manifest: { version: '1.2.3', tier: 'update', notes: 'v2' },
      artifacts: [{ artifactKey: 'suite-app-mac', path: 'new/path.tar.gz', sha256: 'bb', sizeBytes: 20 }],
    }), h)).text) as { id: string };
    expect(second.id).toBe(first.id);
    const art = await withStore(STORE_A, async (tx) => (await tx.execute(sql`SELECT path, sha256 FROM download_artifact`)).rows);
    expect(art).toEqual([{ path: 'suite-app/updates/mac/current/a.tar.gz', sha256: 'aa' }]);
  });

  it('admin-session republish under a claiming policy (no repointArtifacts) keeps the existing download_artifact row', async () => {
    const { owner } = await seed();
    registerApiPlugin(policyPlugin());
    const h = { authorization: `Bearer ${owner}`, 'x-store-slug': SLUG_A };
    const first = JSON.parse((await post(payload(), h)).text) as { id: string };
    const second = JSON.parse((await post(payload({
      manifest: { version: '1.2.3', tier: 'update', notes: 'admin-v2' },
      artifacts: [{ artifactKey: 'suite-app-mac', path: 'admin/new.tar.gz', sha256: 'cc', sizeBytes: 30 }],
    }), h)).text) as { id: string };
    expect(second.id).toBe(first.id);
    const rows = await withStore(STORE_A, async (tx) => (await tx.execute(sql`SELECT path, sha256, app_release_id FROM download_artifact`)).rows);
    expect(rows).toEqual([{ path: 'suite-app/updates/mac/current/a.tar.gz', sha256: 'aa', app_release_id: first.id }]);
  });

  it('default: a new release reusing an existing artifactKey does not steal it from the earlier release', async () => {
    const { owner } = await seed();
    const h = { authorization: `Bearer ${owner}`, 'x-store-slug': SLUG_A };
    const art = (path: string) => [{ artifactKey: 'shared-key', path }];
    const a = JSON.parse((await post({ appKey: 'a', version: '1', platform: 'darwin', manifest: {}, artifacts: art('old') }, h)).text) as { id: string };
    const b = JSON.parse((await post({ appKey: 'a', version: '2', platform: 'darwin', manifest: {}, artifacts: art('new') }, h)).text) as { id: string };
    expect(b.id).not.toBe(a.id);
    const rows = await withStore(STORE_A, async (tx) => (await tx.execute(sql`SELECT path, app_release_id FROM download_artifact`)).rows);
    expect(rows).toEqual([{ path: 'old', app_release_id: a.id }]);
  });

  it('platform null (engine default, no hook): UNIQUE treats NULLs as distinct, so a republish inserts a second row (fork behaviour, COMPAT 6.4)', async () => {
    const { owner } = await seed();
    const h = { authorization: `Bearer ${owner}`, 'x-store-slug': SLUG_A };
    const body = { appKey: 'a', version: '1', platform: null, manifest: {} };
    const a = JSON.parse((await post(body, h)).text) as { id: string };
    const b = JSON.parse((await post(body, h)).text) as { id: string };
    expect(b.id).not.toBe(a.id);
    expect((await counts()).releases).toBe(2);
  });
});

describe('transactionality', () => {
  // Force the artifact write to fail AFTER the release row is written: a trigger that rejects path 'boom'.
  async function armBoom() {
    await pool.query(`CREATE OR REPLACE FUNCTION relreg_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.path = 'boom' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`);
    await pool.query('DROP TRIGGER IF EXISTS relreg_boom ON download_artifact');
    await pool.query('CREATE TRIGGER relreg_boom BEFORE INSERT OR UPDATE ON download_artifact FOR EACH ROW EXECUTE FUNCTION relreg_boom()');
  }
  async function disarmBoom() {
    await pool.query('DROP TRIGGER IF EXISTS relreg_boom ON download_artifact');
    await pool.query('DROP FUNCTION IF EXISTS relreg_boom()');
  }
  afterEach(disarmBoom);

  it('artifact write failure rolls back the release row (no partial write)', async () => {
    await seed();
    await armBoom();
    registerApiPlugin(policyPlugin());
    const r = await post(payload({ artifacts: [{ artifactKey: 'k', path: 'boom' }] }), { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(500);
    expect(await counts()).toEqual({ releases: 0, artifacts: 0 });
  });

  it('duplicate artifactKey in one body with repointArtifacts rolls back too', async () => {
    await seed();
    registerApiPlugin(policyPlugin({ releaseRegistration: { apps: ['suite-app'], repointArtifacts: true, serviceCredential: { sha256: TOKEN_SHA, storeSlug: SLUG_A } } }));
    const dup = { artifactKey: 'same', path: 'p' };
    const r = await post(payload({ artifacts: [dup, dup] }), { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(500);
    expect(await counts()).toEqual({ releases: 0, artifacts: 0 });
  });

  it('failed republish leaves the previously published release untouched', async () => {
    await seed();
    registerApiPlugin(policyPlugin());
    const h = { authorization: `Bearer ${TOKEN}` };
    expect((await post(payload(), h)).status).toBe(200);
    await armBoom();
    expect((await post(payload({ manifest: { version: '1.2.3', tier: 'update', notes: 'bad' }, artifacts: [{ artifactKey: 'other', path: 'boom' }] }), h)).status).toBe(500);
    const m = await withStore(STORE_A, async (tx) => (await tx.execute(sql`SELECT manifest FROM app_release`)).rows[0] as { manifest: { notes?: string } });
    expect(m.manifest.notes).toBeUndefined();
  });
});

describe('startup conflicts (createApp)', () => {
  it('two plugins claiming the same app fail createApp', () => {
    registerApiPlugin(policyPlugin({ name: 'p1' }));
    registerApiPlugin({ name: 'p2', releaseRegistration: { apps: ['x', 'suite-app'] } });
    expect(() => createApp()).toThrow(/both claim app suite-app/);
  });

  it('a catch-all policy conflicts with any other policy', () => {
    registerApiPlugin({ name: 'p1', releaseRegistration: {} });
    registerApiPlugin({ name: 'p2', releaseRegistration: { apps: ['x'] } });
    expect(() => createApp()).toThrow(/catch-all/);
  });

  it('two plugins sharing a service credential fail createApp', () => {
    registerApiPlugin({ name: 'p1', releaseRegistration: { apps: ['a'], serviceCredential: { sha256: TOKEN_SHA, storeSlug: SLUG_A } } });
    registerApiPlugin({ name: 'p2', releaseRegistration: { apps: ['b'], serviceCredential: { sha256: TOKEN_SHA.toUpperCase(), storeSlug: SLUG_B } } });
    expect(() => createApp()).toThrow(/share a service credential/);
  });

  it('a plugin mounting the host-owned route fails createApp', () => {
    const routes = new OpenAPIHono();
    routes.post('/v1/admin/apps/releases', (c) => c.json({}));
    registerApiPlugin({ name: 'shadow', routes });
    expect(() => createApp()).toThrow(/owned by the engine release registration host/);
  });

  it('a plugin registering the host-owned route inside init() fails createApp', () => {
    registerApiPlugin({ name: 'sneaky', init: (a) => { a.post('/v1/admin/apps/releases', (c) => c.json({})); } });
    expect(() => createApp()).toThrow(/registered it again/);
  });

  it('two plugins mounting the same method+path fail createApp', () => {
    const a = new OpenAPIHono(); a.get('/v1/x', (c) => c.json({}));
    const b = new OpenAPIHono(); b.get('/v1/x', (c) => c.json({}));
    registerApiPlugin({ name: 'a', routes: a });
    registerApiPlugin({ name: 'b', routes: b });
    expect(() => createApp()).toThrow(/both mount GET \/v1\/x/);
  });

  it('a malformed credential fails createApp', () => {
    registerApiPlugin({ name: 'p', releaseRegistration: { apps: ['a'], serviceCredential: { sha256: 'nope', storeSlug: SLUG_A } } });
    expect(() => createApp()).toThrow(/invalid release service credential/);
  });

  it('a valid policy boots and the host serves the route', async () => {
    await seed();
    registerApiPlugin(policyPlugin());
    const full = createApp();
    const res = await full.request('/v1/admin/apps/releases', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(payload()),
    });
    expect(res.status).toBe(200);
  });
});
