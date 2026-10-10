import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { OpenAPIHono } from '@hono/zod-openapi';
import { preRoutePolicy, pathMatches, type ErrorBodyTransformer } from './pre-route-policy.js';
import type { ApiPlugin } from './plugins.js';

vi.setConfig({ testTimeout: 60000 });

/**
 * Generic stand-in for a plugin's legacy shape: flatten {error:{code,message,..}}
 * to {error:"message", code?, param?, requestId?}, siblings kept in place.
 * (Reproduces the fork's wire shape; lives in the test, not the engine.)
 */
const flatten: ErrorBodyTransformer = (body) => {
  if (!body || typeof body !== 'object') return undefined;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== 'object' || typeof (err as { message?: unknown }).message !== 'string') return undefined;
  const { code, message, param, requestId } = err as { code?: string; message: string; param?: string; requestId?: string };
  return {
    ...(body as Record<string, unknown>),
    error: message,
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
    ...(requestId ? { requestId } : {}),
  };
};

function appWith(plugins: ApiPlugin[]) {
  const app = new Hono();
  app.use('*', preRoutePolicy(() => plugins));
  const env = (code: string, message: string) => ({ error: { code, message, requestId: 'r1' }, reason: 'x' });
  app.get('/v1/licenses/x', (c) => c.json(env('BAD', 'bad key'), 400, { 'x-request-id': 'r1', 'x-custom': 'keep', 'cache-control': 'no-store' }));
  app.post('/v1/licenses/x', (c) => c.json(env('BAD', 'bad key'), 409, { 'x-request-id': 'r1' }));
  app.get('/v1/other/x', (c) => c.json(env('BAD', 'other'), 400));
  app.get('/v1/admin/x', (c) => c.json(env('FORBIDDEN', 'no'), 403));
  app.get('/v1/ok', (c) => c.json({ ok: true }));
  app.get('/v1/text', (c) => c.text('nope', 500));
  return app;
}

const policyPlugin = (routes: { method?: string; path: string }[]): ApiPlugin => ({
  name: 'p',
  errorPolicy: { routes, transform: flatten },
});

describe('preRoutePolicy', () => {
  it('is a no-op with no plugin policy', async () => {
    const r = await appWith([{ name: 'plain' }]).request('/v1/licenses/x');
    expect(await r.json()).toEqual({ error: { code: 'BAD', message: 'bad key', requestId: 'r1' }, reason: 'x' });
  });

  it('applies the plugin shape only on declared routes', async () => {
    const app = appWith([policyPlugin([{ method: 'GET', path: '/v1/licenses/*' }])]);
    expect(await (await app.request('/v1/licenses/x')).json()).toEqual({ error: 'bad key', code: 'BAD', requestId: 'r1', reason: 'x' });
    // undeclared path
    expect(await (await app.request('/v1/other/x')).json()).toEqual({ error: { code: 'BAD', message: 'other', requestId: 'r1' }, reason: 'x' });
    // declared path, undeclared method
    expect(await (await app.request('/v1/licenses/x', { method: 'POST' })).json()).toMatchObject({ error: { code: 'BAD' } });
  });

  it('never transforms /v1/admin even when declared', async () => {
    const app = appWith([policyPlugin([{ path: '/*' }, { path: '/v1/admin/x' }])]);
    expect(await (await app.request('/v1/admin/x')).json()).toEqual({ error: { code: 'FORBIDDEN', message: 'no', requestId: 'r1' }, reason: 'x' });
    expect(await (await app.request('/v1/other/x')).json()).toMatchObject({ error: 'other' });
  });

  it('preserves status, headers and request id', async () => {
    const app = appWith([policyPlugin([{ path: '/*' }])]);
    const r = await app.request('/v1/licenses/x');
    expect(r.status).toBe(400);
    expect(r.headers.get('x-request-id')).toBe('r1');
    expect(r.headers.get('x-custom')).toBe('keep');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('content-length')).toBeNull();
    expect((await app.request('/v1/licenses/x', { method: 'POST' })).status).toBe(409);
  });

  it('passes success, non-JSON and declined (undefined) transforms through', async () => {
    const app = appWith([policyPlugin([{ path: '/*' }])]);
    expect(await (await app.request('/v1/ok')).json()).toEqual({ ok: true });
    const t = await app.request('/v1/text');
    expect(t.status).toBe(500);
    expect(await t.text()).toBe('nope');
    const decline = appWith([{ name: 'd', errorPolicy: { routes: [{ path: '/*' }], transform: () => undefined } }]);
    expect(await (await decline.request('/v1/licenses/x')).json()).toMatchObject({ error: { code: 'BAD' } });
  });

  it('keeps the original error when a transformer throws, and still applies later policies', async () => {
    const boom: ApiPlugin = { name: 'boom', errorPolicy: { routes: [{ path: '/*' }], transform: () => { throw new Error('plugin bug'); } } };
    const solo = await appWith([boom]).request('/v1/licenses/x');
    expect(solo.status).toBe(400);
    expect(await solo.json()).toEqual({ error: { code: 'BAD', message: 'bad key', requestId: 'r1' }, reason: 'x' });
    const chained = await appWith([boom, policyPlugin([{ path: '/*' }])]).request('/v1/licenses/x');
    expect(chained.status).toBe(400);
    expect(await chained.json()).toEqual({ error: 'bad key', code: 'BAD', requestId: 'r1', reason: 'x' });
  });

  it('pathMatches: exact, prefix wildcard, :param', () => {
    expect(pathMatches('/a/b', '/a/b')).toBe(true);
    expect(pathMatches('/a/b', '/a/b/c')).toBe(false);
    expect(pathMatches('/a/*', '/a/b/c')).toBe(true);
    expect(pathMatches('/a/*', '/ab')).toBe(false);
    expect(pathMatches('/a/:id/z', '/a/1/z')).toBe(true);
    expect(pathMatches('/a/:id/z', '/a/1/2/z')).toBe(false);
  });
});

describe('createApp integration: byte-identical to the captured legacy bytes (COMPAT C4)', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; vi.restoreAllMocks(); });

  async function boot() {
    dir = mkdtempSync(join(tmpdir(), 'sr-preroute-'));
    vi.resetModules();
    vi.doMock('./env.js', () => ({ env: { DEBUG_ERRORS: '0', MAINTENANCE_FLAG_FILE: join(dir!, 'MAINTENANCE') } }));
    const [{ createApp }, plugins, maintenance] = await Promise.all([
      import('./app.js'), import('./plugins.js'), import('./maintenance.js'),
    ]);
    const routes = new OpenAPIHono();
    routes.get('/v1/boom', () => { throw new Error('secret detail'); });
    routes.get('/v1/admin/boom', () => { throw new Error('secret detail'); });
    plugins.registerApiPlugin({
      name: 'legacy-shape',
      routes,
      errorPolicy: { routes: [{ path: '/*' }], transform: flatten },
    });
    return { app: createApp(), maintenance };
  }

  const h = { 'x-request-id': 'req-fixed-0001' };

  it('non-admin 500', async () => {
    const { app } = await boot();
    const r = await app.request('/v1/boom', { headers: h });
    expect(r.status).toBe(500);
    expect(r.headers.get('x-request-id')).toBe('req-fixed-0001');
    expect(await r.text()).toBe('{"error":"internal error","code":"INTERNAL_ERROR","requestId":"req-fixed-0001"}');
  });

  it('non-admin maintenance 503', async () => {
    const { app, maintenance } = await boot();
    maintenance.setMaintenance(true);
    const r = await app.request('/v1/licenses/activate', { method: 'POST', headers: h });
    expect(r.status).toBe(503);
    expect(await r.text()).toBe('{"maintenance":true,"error":"The store is temporarily unavailable for maintenance. Please try again shortly.","code":"MAINTENANCE","requestId":"req-fixed-0001"}');
  });

  it('admin maintenance 503 keeps the envelope', async () => {
    const { app, maintenance } = await boot();
    maintenance.setMaintenance(true);
    const r = await app.request('/v1/admin/anything', { method: 'POST', headers: h });
    expect(r.status).toBe(503);
    expect(await r.text()).toBe('{"maintenance":true,"error":{"code":"MAINTENANCE","message":"The store is temporarily unavailable for maintenance. Please try again shortly.","requestId":"req-fixed-0001"}}');
  });

  it('admin 500 keeps the envelope', async () => {
    const { app } = await boot();
    const r = await app.request('/v1/admin/boom', { headers: h });
    expect(r.status).toBe(500);
    expect(await r.text()).toBe('{"error":{"code":"INTERNAL_ERROR","message":"internal error","requestId":"req-fixed-0001"}}');
  });
});
