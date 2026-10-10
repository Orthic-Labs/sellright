/**
 * SDK lifecycle (plan 2.1/2.5/2.6): real Postgres (*_test), real createApp.
 * This file must not touch `env` / `pool` before createApp runs — that is part of what it proves.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { _resetEnvForTest, envOrigin } from '../env.js';
import { poolsInitialised, _resetPoolsForTest } from '../db/client.js';
import { createApp, EngineSetupError } from './create-app.js';
import { PendingMigrationsError } from './migrations.js';
import { routeInventory } from './route-inventory.js';
import { getEngineState } from './engine-state.js';
import type { EngineApp, EnginePlugin } from './types.js';

const DB = process.env.DATABASE_URL as string;
assertTestDatabase(DB, 'create-app.db.test.ts');

const baseEnv = (extra: Record<string, string | undefined> = {}) => ({ ...process.env, NODE_ENV: 'test', ...extra });

// CI runs the db project as a superuser (DATABASE_URL). The runtime privilege check (plan 2.6) has its own tests;
// every other createApp here passes the test-only override when the configured role is privileged.
async function rolePrivileged(url: string): Promise<boolean> {
  const c = new pg.Client({ connectionString: url });
  try {
    await c.connect();
    const r = await c.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    return Boolean(r.rows[0]?.rolsuper || r.rows[0]?.rolbypassrls);
  } finally { await c.end().catch(() => undefined); }
}
const rt = (await rolePrivileged(DB)) ? { allowPrivilegedRuntimeRole: true } : {};
const here = dirname(fileURLToPath(import.meta.url));

let engine: EngineApp | undefined;
afterEach(async () => {
  await engine?.shutdown().catch(() => undefined);
  engine = undefined;
  _resetEnvForTest();
  _resetPoolsForTest();
});

function recordingPlugin(log: string[], over: Partial<EnginePlugin> = {}): EnginePlugin {
  const routes = new OpenAPIHono();
  routes.openapi(
    createRoute({ method: 'get', path: '/v1/rec/documented', responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } } } }),
    (c) => c.json({ ok: true }, 200),
  );
  routes.get('/v1/rec/plain', (c) => c.json({ ok: true }));
  routes.on('PUT', '/v1/rec/on', (c) => c.json({ ok: true }));
  return {
    name: 'rec',
    configure: (ctx) => { log.push('configure'); ctx.extendEnv({ REC_FLAG: z.string().default('x') }); },
    preRoute: (app) => { log.push('preRoute'); app.use('*', async (c, next) => { await next(); c.header('x-rec', '1'); }); },
    routes: () => { log.push('routes'); return routes; },
    schema: () => { log.push('schema'); return {}; },
    services: () => { log.push('services'); },
    jobs: () => { log.push('jobs'); return [{ name: 'tick', intervalMs: 50, run: async () => { log.push('tick'); } }]; },
    effectiveConfig: (_ctx, fp) => ({ intended: { rec: fp.symmetric('rec-secret', 'REC').fingerprint }, deployment: { recNote: 'n' } }),
    shutdown: () => { log.push('shutdown'); },
    ...over,
  };
}

describe('createApp lifecycle', () => {
  it('runs hooks in the plan order and parses env + creates the pool inside createApp', async () => {
    expect(envOrigin()).toBeUndefined();
    expect(poolsInitialised()).toBe(false);
    const log: string[] = [];
    engine = await createApp({ ...rt, plugins: [recordingPlugin(log)], env: baseEnv({ PGAPPNAME: 'sdk-lifecycle-test' }) });
    expect(envOrigin()).toBe('explicit');
    expect(poolsInitialised()).toBe(true);
    expect(log).toEqual(['configure', 'preRoute', 'routes', 'schema', 'services']);
    expect(engine.executedPhases).toEqual(['configure', 'preRoute', 'routes', 'schema', 'migrations', 'services']);
    // the supplied env source (not process.env) drove the pool
    const r = await engine.ctx.pool.query("SELECT current_setting('application_name') AS n");
    expect(r.rows[0].n).toBe('sdk-lifecycle-test');
    const res = await engine.app.request('/v1/rec/documented');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-rec')).toBe('1');

    await engine.start({ listen: { port: 0, hostname: '127.0.0.1' } });
    expect(engine.executedPhases.at(-1)).toBe('jobs');
    expect(log.slice(5)).toEqual(['jobs']);
    const live = await fetch(`http://127.0.0.1:${engine.port}/v1/health`);
    expect(live.status).toBe(200);
    const port = engine.port;

    await engine.shutdown();
    expect(engine.executedPhases.at(-1)).toBe('shutdown');
    expect(log.at(-1)).toBe('shutdown');
    expect(poolsInitialised()).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/v1/health`)).rejects.toThrow();
  });

  it('shuts down in order: stop admitting -> cancel jobs -> drain HTTP -> plugin hooks -> resources -> pool', async () => {
    const log: string[] = [];
    engine = await createApp({ ...rt, plugins: [recordingPlugin(log)], env: baseEnv({ NODE_ENV: 'development', JOBS_ENABLED: '1' }) });
    await engine.start({ listen: { port: 0, hostname: '127.0.0.1' } });
    expect(getEngineState()?.jobs().names).toContain('rec:tick');
    await new Promise((r) => setTimeout(r, 400));
    expect(log.filter((l) => l === 'tick').length).toBeGreaterThan(0);

    const done = engine.shutdown();
    // step 1 is synchronous: a request arriving now is refused, the pool is still open
    const refused = await engine.app.request('/v1/health');
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('SHUTTING_DOWN');
    await done;
    expect(engine.shutdownSteps.map((s) => s.step)).toEqual(['stop-admitting', 'cancel-jobs', 'drain-http', 'plugin-shutdown', 'close-resources', 'close-pool']);
    const times = engine.shutdownSteps.map((s) => s.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // timers are really cancelled: no tick after shutdown
    const ticks = log.filter((l) => l === 'tick').length;
    await new Promise((r) => setTimeout(r, 250));
    expect(log.filter((l) => l === 'tick').length).toBe(ticks);
    // idempotent
    await expect(engine.shutdown()).resolves.toBeUndefined();
  }, 30_000);

  it('verifies every migration track; pending migrations stop boot and release the runtime', async () => {
    await expect(createApp({ ...rt, env: baseEnv(), migrationsTable: 'definitely_missing_journal' })).rejects.toBeInstanceOf(PendingMigrationsError);
    expect(poolsInitialised()).toBe(false);
    expect(envOrigin()).toBeUndefined();
    // a plugin track whose journal table is absent is also refused
    const folder = join(here, '..', '..', '..', 'sample-plugin', 'drizzle');
    const plugin: EnginePlugin = { name: 'pending-track', migrations: { folder, table: '__never_applied' } };
    await expect(createApp({ ...rt, env: baseEnv(), plugins: [plugin] })).rejects.toThrow(/pending-track/);
    // skip mode does not look
    engine = await createApp({ ...rt, env: baseEnv(), migrationsTable: 'definitely_missing_journal', migrations: 'skip' });
    expect(engine.phase).toBe('created');
  });

  it('rejects a second createApp while one is active, and a runtime touched before createApp', async () => {
    engine = await createApp({ ...rt, env: baseEnv() });
    await expect(createApp({ ...rt, env: baseEnv() })).rejects.toMatchObject({ code: 'ENGINE_ACTIVE' });
    await engine.shutdown();
    engine = undefined;

    _resetEnvForTest();
    const { env } = await import('../env.js');
    void env.NODE_ENV; // implicit init, as an import-time touch would do
    await expect(createApp({ ...rt, env: baseEnv() })).rejects.toMatchObject({ code: 'RUNTIME_PREINITIALISED' });
  });

  it('validates plugins: names, duplicates, engine version, table collisions', async () => {
    const mk = (over: Partial<EnginePlugin>): EnginePlugin => ({ name: 'p', ...over });
    await expect(createApp({ ...rt, env: baseEnv(), plugins: [mk({ name: 'Bad Name' })] })).rejects.toMatchObject({ code: 'PLUGIN_NAME' });
    await expect(createApp({ ...rt, env: baseEnv(), plugins: [mk({}), mk({})] })).rejects.toMatchObject({ code: 'PLUGIN_DUPLICATE' });
    await expect(createApp({ ...rt, env: baseEnv(), plugins: [mk({ engineVersion: '9.9.9' })] })).rejects.toMatchObject({ code: 'PLUGIN_ENGINE_VERSION' });
    const clash = pgTable('store', { id: uuid().primaryKey(), x: text() });
    await expect(createApp({ ...rt, env: baseEnv(), plugins: [mk({ schema: { clash } })] })).rejects.toMatchObject({ code: 'SCHEMA_COLLISION' });
    expect(poolsInitialised()).toBe(false);
  });
});

describe('privilege check (plan 2.6)', () => {
  const privUrl = (() => { const u = new URL(DB); u.username = 'sellright_backup'; u.password = ''; return u.toString(); })();

  async function privRoleUsable(): Promise<boolean> {
    const c = new pg.Client({ connectionString: privUrl });
    try { await c.connect(); const r = await c.query('SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user'); return Boolean(r.rows[0]?.rolbypassrls || r.rows[0]?.rolsuper); } catch { return false; } finally { await c.end().catch(() => undefined); }
  }

  it('refuses a BYPASSRLS/superuser runtime role', async () => {
    if (!(await privRoleUsable())) return; // role not reachable in this environment
    await expect(createApp({ env: baseEnv({ DATABASE_URL: privUrl }) })).rejects.toThrow(/privileged Postgres role/);
    expect(poolsInitialised()).toBe(false);
  });

  it('the explicit override works only under NODE_ENV=test', async () => {
    if (await privRoleUsable()) {
      engine = await createApp({ env: baseEnv({ DATABASE_URL: privUrl }), allowPrivilegedRuntimeRole: true, migrations: 'skip' });
      expect(engine.phase).toBe('created');
      await engine.shutdown();
      engine = undefined;
    }
    await expect(createApp({ env: baseEnv({ NODE_ENV: 'development' }), allowPrivilegedRuntimeRole: true })).rejects.toMatchObject({ code: 'PRIVILEGE_OVERRIDE' });
  });

  it('accepts the unprivileged runtime role without any override', async () => {
    // Where DATABASE_URL is privileged (CI), use the dedicated non-owner app role for this check.
    const appUrl = Object.keys(rt).length ? process.env.DATABASE_URL_NONOWNER : DB;
    if (!appUrl) return; // no unprivileged role reachable in this environment
    engine = await createApp({ env: baseEnv({ DATABASE_URL: appUrl }), migrations: 'skip' });
    const r = await engine.ctx.pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('system endpoints inside a composed engine (plan 2.7)', () => {
  it('merges plugin effectiveConfig sections and reports engine state', async () => {
    const log: string[] = [];
    engine = await createApp({ ...rt, env: baseEnv(), plugins: [recordingPlugin(log)] });
    await engine.start({ listen: { port: 0, hostname: '127.0.0.1' } });
    const { hashPassword } = await import('../auth/password.js');
    const { createAdminSession } = await import('../auth/admin-session.js');
    const pool = engine.ctx.pool;
    await pool.query('TRUNCATE store CASCADE');
    await pool.query('DELETE FROM "session"');
    await pool.query('DELETE FROM admin_user');
    const STORE = 'eeeeeeee-0000-0000-0000-00000000c101';
    const ADMIN = 'eeeeeeee-0000-0000-0000-00000000c102';
    await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'sdk-sys', 'S', 'USD', '{}'::jsonb)`, [STORE]);
    await pool.query(`INSERT INTO admin_user (id, email, password_hash, is_installation_admin) VALUES ($1, 'o@sdk.test', $2, true)`, [ADMIN, await hashPassword('pw-sdk-test-1')]);
    await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner')`, [ADMIN, STORE]);
    const token = await createAdminSession(ADMIN);
    const headers = { authorization: `Bearer ${token}`, 'x-store-slug': 'sdk-sys' };
    const cfg = (await (await engine.app.request('/v1/admin/system/effective-config', { headers })).json()) as Record<string, any>;
    expect(cfg.intended.plugins.rec.rec).toMatch(/^[0-9a-f]{16}$/);
    expect(cfg.deployment.plugins.rec).toEqual({ recNote: 'n' });
    expect(cfg.deployment.pluginNames).toEqual(['rec']);
    expect(cfg.deployment.port).toBe(engine.port);
    expect(cfg.deployment.migrations.engineTable).toBe('drizzle.__drizzle_migrations');
    const bi = (await (await engine.app.request('/v1/admin/system/build-info', { headers })).json()) as Record<string, any>;
    expect(bi.plugins).toEqual(['rec']);
    await pool.query('TRUNCATE store CASCADE');
    await pool.query('DELETE FROM "session"');
    await pool.query('DELETE FROM admin_user');
  });
});

describe('route inventory (plan 2.5)', () => {
  const GOLDEN = join(here, 'route-inventory.golden.json');

  it('matches the checked-in engine inventory; every OpenAPI operation has a route; plugin .get/.on routes are listed', async () => {
    engine = await createApp({ ...rt, env: baseEnv(), plugins: [recordingPlugin([])] });
    const inv = await routeInventory(engine.app);
    const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
    expect(inv.orphanedOpenApi).toEqual([]);
    const pluginKeys = inv.routes.filter((r) => r.path.startsWith('/v1/rec/')).map(key);
    expect(pluginKeys).toEqual(['GET /v1/rec/documented', 'GET /v1/rec/plain', 'PUT /v1/rec/on']);
    expect(inv.undocumented.filter((r) => r.path.startsWith('/v1/rec/')).map(key)).toEqual(['GET /v1/rec/plain', 'PUT /v1/rec/on']);

    const engineRoutes = inv.routes.filter((r) => !r.path.startsWith('/v1/rec/')).map(key);
    const engineUndocumented = inv.undocumented.filter((r) => !r.path.startsWith('/v1/rec/')).map(key);
    const snapshot = { count: engineRoutes.length, routes: engineRoutes, undocumented: engineUndocumented };
    if (process.env.UPDATE_ROUTE_GOLDEN === '1' || !existsSync(GOLDEN)) writeFileSync(GOLDEN, JSON.stringify(snapshot, null, 2) + '\n');
    expect(snapshot).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
    expect(engineRoutes).toEqual(expect.arrayContaining(['GET /v1/admin/system/build-info', 'GET /v1/admin/system/effective-config', 'GET /v1/health', 'GET /v1/readyz']));
  });
});

// keep createHash referenced for lint parity with sibling tests
void createHash;
void EngineSetupError;
