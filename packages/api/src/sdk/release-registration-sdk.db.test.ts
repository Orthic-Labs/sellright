/**
 * SDK `EnginePlugin.releaseRegistration` (defork 3.2 via the SDK surface). Proves the policy is
 * honoured by the engine-hosted release route, and that conflicts fail startup (buildHttpApp throws),
 * including conflicts against a legacy `registerApiPlugin` plugin. *_test database ONLY (TRUNCATEs).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { invalidateStoreCache } from '../store-context.js';
import { _clearApiPluginsForTest, registerApiPlugin } from '../plugins.js';
import { buildHttpApp } from '../app.js';
import type { ReleaseRegistrationBody } from '../releases/registration-policy.js';
import type { EngineContext, EnginePlugin } from './types.js';

assertTestDatabase(process.env.DATABASE_URL ?? '', 'release-registration-sdk.db.test.ts');

const STORE_A = 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdc1';
const SLUG_A = 'sdk-rel-a';
const TOKEN = 'sdk-release-token';
const TOKEN_SHA = createHash('sha256').update(TOKEN).digest('hex');
const ctx = {} as EngineContext;

function validate(body: ReleaseRegistrationBody): ReleaseRegistrationBody {
  if ((body.manifest as { version?: string }).version !== body.version) throw new Error('manifest version mismatch');
  return body;
}

function sdkPlugin(name: string, releaseRegistration: EnginePlugin['releaseRegistration'], routes?: OpenAPIHono): EnginePlugin {
  return { name, releaseRegistration, ...(routes ? { routes } : {}) };
}

function payload(over: Record<string, unknown> = {}) {
  return {
    appKey: 'sdk-app', version: '2.0.0', channel: 'stable', platform: 'darwin',
    manifest: { version: '2.0.0' },
    artifacts: [{ artifactKey: 'sdk-app-mac', path: 'sdk-app/mac/a.tar.gz' }],
    ...over,
  };
}

async function post(app: OpenAPIHono, body: unknown) {
  const res = await app.request('/v1/admin/apps/releases', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body),
  });
  return res.status;
}

async function releaseCount(): Promise<number> {
  return withStore(STORE_A, async (tx) => {
    const r = await tx.execute(sql`SELECT count(*)::int AS n FROM app_release`);
    return (r.rows[0] as { n: number }).n;
  });
}

beforeEach(async () => {
  _clearApiPluginsForTest();
  invalidateStoreCache();
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE_A, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE_A}, ${SLUG_A}, ${SLUG_A}) ON CONFLICT (id) DO NOTHING`);
  });
});
afterAll(async () => {
  _clearApiPluginsForTest();
  await pool.query('TRUNCATE store CASCADE');
  await pool.end();
});

describe('SDK plugin releaseRegistration is honoured', () => {
  const policy = { apps: ['sdk-app'], channels: ['stable'], serviceCredential: { sha256: TOKEN_SHA, storeSlug: SLUG_A }, validate };

  it('the claiming SDK policy publishes through the engine release route', async () => {
    const app = buildHttpApp({ plugins: [sdkPlugin('sdk-rel', policy)], ctx });
    expect(await post(app, payload())).toBe(200);
    expect(await releaseCount()).toBe(1);
  });

  it('the policy validate hook runs and its rejection writes nothing', async () => {
    const app = buildHttpApp({ plugins: [sdkPlugin('sdk-rel', policy)], ctx });
    expect(await post(app, payload({ manifest: { version: '9.9.9' } }))).toBe(400);
    expect(await releaseCount()).toBe(0);
  });

  it('an app the SDK policy does not claim is refused once the policy is active', async () => {
    const app = buildHttpApp({ plugins: [sdkPlugin('sdk-rel', policy)], ctx });
    expect(await post(app, payload({ appKey: 'other-app' }))).toBe(400);
    expect(await releaseCount()).toBe(0);
  });
});

describe('conflicts fail startup', () => {
  it('two SDK plugins claiming the same app', () => {
    const a = sdkPlugin('sdk-a', { apps: ['shared'] });
    const b = sdkPlugin('sdk-b', { apps: ['shared'] });
    expect(() => buildHttpApp({ plugins: [a, b], ctx })).toThrow(/release registration conflict: plugins "sdk-a" and "sdk-b" both claim app shared/);
  });

  it('an SDK plugin and a legacy registerApiPlugin plugin claiming the same app', () => {
    registerApiPlugin({ name: 'legacy-rel', releaseRegistration: { apps: ['shared'] } });
    const sdk = sdkPlugin('sdk-rel', { apps: ['shared'] });
    expect(() => buildHttpApp({ plugins: [sdk], ctx })).toThrow(/release registration conflict: plugins "legacy-rel" and "sdk-rel"/);
  });

  it('an SDK plugin mounting the engine-owned release route', () => {
    const routes = new OpenAPIHono();
    routes.post('/v1/admin/apps/releases', (c) => c.json({ ok: true }));
    expect(() => buildHttpApp({ plugins: [sdkPlugin('sdk-squat', undefined, routes)], ctx })).toThrow(/owned by the engine release registration host/);
  });
});
