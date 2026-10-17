import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { buildHttpApp } from './app.js';
import type { EngineContext, EnginePlugin, ExactRouteCorsPolicy } from './sdk/index.js';

vi.mock('./cors-origins.js', () => ({
  isAllowedCorsOrigin: async (origin: string) => origin === 'https://default.example',
  isAllowedAdminCorsOrigin: (origin: string) => origin === 'https://admin.example',
}));
vi.mock('./maintenance.js', () => ({ isMaintenanceOn: () => false, maintenanceInfo: () => ({ maintenance: false }) }));

const PATH = '/compat/example/update.json';
const ctx = { env: {} } as EngineContext;
const policy: ExactRouteCorsPolicy = {
  path: PATH, origins: ['https://app.example', 'app://localhost', 'tauri://localhost', 'null'],
  loopback: true, missingOrigin: '*', fallbackOrigin: 'https://app.example',
  methods: ['GET', 'OPTIONS'], headers: ['Content-Type', 'Authorization', 'X-Device'],
  maxAge: 86400, credentials: 'absent', options: 'respond-204',
};

function composition(policies: readonly ExactRouteCorsPolicy[] = [policy]) {
  const routes = new OpenAPIHono();
  const called = vi.fn();
  routes.all(PATH, (c) => {
    called();
    const status = Number(c.req.query('status') ?? 200);
    return new Response(status === 204 ? null : JSON.stringify({ ok: true }), { status, headers: {
      'Access-Control-Allow-Origin': 'https://inherited.example', 'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers': '*', 'Access-Control-Allow-Private-Network': 'true',
      'X-Endpoint': 'preserved', Vary: 'Accept-Encoding, origin',
    } });
  });
  routes.all('/compat/checkout', (c) => new Response(null, { status: 303, headers: {
    Location: `https://checkout.example/checkout${new URL(c.req.url).search}`,
    'X-Endpoint': 'redirect', 'Access-Control-Allow-Credentials': 'true',
  } }));
  routes.get(`${PATH}/neighbor`, (c) => c.json({ neighbor: true }));
  const plugin: EnginePlugin = { name: 'cors-test', corsPolicies: policies, routes };
  return { app: buildHttpApp({ ctx, plugins: [plugin] }), called };
}

describe('composed exact-route CORS', () => {
  it.each([
    ['https://app.example', 'https://app.example'],
    ['https://other.example', 'https://app.example'],
    ['null', 'null'], ['app://localhost', 'app://localhost'], ['tauri://localhost', 'tauri://localhost'],
    ['http://localhost:32891', 'http://localhost:32891'], ['https://127.0.0.1:4443', 'https://127.0.0.1:4443'],
    ['http://localhost:80', 'http://localhost:80'], ['https://127.0.0.1:443', 'https://127.0.0.1:443'],
    ['http://[::1]:8192', 'http://[::1]:8192'], ['http://localhost.evil:8192', 'https://app.example'],
    ['http://127.0.0.2:8192', 'https://app.example'], ['http://localhost:8192/path', 'https://app.example'],
    ['', '*'], [undefined, '*'],
  ])('uses declared origin %s on OPTIONS and actual responses', async (origin, expected) => {
    const { app, called } = composition();
    for (const method of ['OPTIONS', 'GET']) {
      const response = await app.request(PATH, { method, headers: origin === undefined ? {} : { Origin: origin } });
      expect(response.status).toBe(method === 'OPTIONS' ? 204 : 200);
      expect(response.headers.get('access-control-allow-origin')).toBe(expected);
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      expect(response.headers.get('access-control-expose-headers')).toBeNull();
      expect(response.headers.get('access-control-allow-private-network')).toBeNull();
      expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
      expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type, Authorization, X-Device');
      expect(response.headers.get('access-control-max-age')).toBe('86400');
      expect(response.headers.get('vary')?.toLowerCase().split(',').map((part) => part.trim()).filter((part) => part === 'origin')).toHaveLength(1);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-request-id')).toBeTruthy();
      if (method === 'GET') expect(response.headers.get('x-endpoint')).toBe('preserved');
    }
    expect(called).toHaveBeenCalledTimes(1);
  });

  it.each([204, 400, 401, 403, 429, 503])('normalizes inherited CORS on status %i', async (status) => {
    const { app } = composition();
    const response = await app.request(`${PATH}?status=${status}`, { headers: { Origin: 'https://app.example' } });
    expect(response.status).toBe(status);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('continues OPTIONS to the all-method redirect without inherited CORS', async () => {
    const { app } = composition([{ path: '/compat/checkout', origins: [], methods: [], headers: [], credentials: 'absent', options: 'continue' }]);
    for (const method of ['OPTIONS', 'GET', 'POST']) {
      const response = await app.request('/compat/checkout?sku=x%2Fy&sku=2', { method, headers: { Origin: 'https://default.example' } });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('https://checkout.example/checkout?sku=x%2Fy&sku=2');
      expect([...response.headers.keys()].filter((key) => key.startsWith('access-control-'))).toEqual([]);
      expect(response.headers.get('x-endpoint')).toBe('redirect');
    }
  });

  it('normalizes immutable redirect responses and preserves unrelated headers', async () => {
    const routes = new OpenAPIHono();
    routes.get(PATH, () => Response.redirect('https://redirect.example', 303));
    const app = buildHttpApp({ ctx, plugins: [{ name: 'immutable', corsPolicies: [policy], routes }] });
    const response = await app.request(PATH);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://redirect.example/');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('keeps neighboring default CORS and credential/CSRF guards unchanged', async () => {
    let hookReached = 0;
    const app = buildHttpApp({ ctx, plugins: [{ name: 'guard-probe', corsPolicies: [policy], preRoute(routes) {
      routes.all('/v1/admin/plugin-probe', (c) => { hookReached++; return c.json({ ok: true }); });
      routes.all('/v1/shop/plugin-probe', (c) => { hookReached++; return c.json({ ok: true }); });
    } }] });
    const neighbor = await app.request(`${PATH}/neighbor`, { method: 'OPTIONS', headers: { Origin: 'https://default.example' } });
    expect(neighbor.status).toBe(204);
    expect(neighbor.headers.get('access-control-allow-origin')).toBe('https://default.example');
    expect(neighbor.headers.get('access-control-allow-credentials')).toBe('true');
    expect((await app.request('/v1/admin/plugin-probe')).status).toBe(401);
    expect((await app.request('/v1/admin/plugin-probe', { method: 'POST', headers: { Cookie: 'sr_admin=present' } })).status).toBe(403);
    expect((await app.request('/v1/shop/plugin-probe', { method: 'POST', headers: { Cookie: 'sr_cust=present' } })).status).toBe(403);
    expect(hookReached).toBe(0);
  });

  it('isolates validated policy copies between app instances', async () => {
    const origins = ['https://first.example'];
    const { app } = composition([{ ...policy, origins, loopback: false, fallbackOrigin: undefined, missingOrigin: undefined }]);
    origins.push('https://late.example');
    expect((await app.request(PATH, { headers: { Origin: 'https://late.example' } })).headers.get('access-control-allow-origin')).toBeNull();
    const plain = composition([]).app;
    expect((await plain.request(PATH, { method: 'OPTIONS', headers: { Origin: 'https://default.example' } })).headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('keeps encoded path aliases outside exact-route policy admission', async () => {
    const { app } = composition();
    const response = await app.request('/compat/example/%75pdate.json', {
      method: 'OPTIONS', headers: { Origin: 'https://default.example', 'x-request-id': 'encoded-cors-probe' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://default.example');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-max-age')).toBeNull();
    expect(response.headers.get('x-request-id')).toBe('encoded-cors-probe');
  });

  it('rejects conflicts, route patterns, protected paths and invalid policy data at construction', () => {
    expect(() => composition([policy, policy])).toThrow(/duplicate/);
    for (const path of ['/v1/admin/x', '/v1/shop/x', '/v1/apps/x', '/api/licenses/activate', '/api/licenses/trial', '/releases/latest.json', '/.well-known/x', '/compat/*', '/compat/:id', '/compat/{id}', '/compat/%78', '/compat/../x', '//compat/x']) {
      expect(() => composition([{ ...policy, path }]), path).toThrow();
    }
    for (const invalid of [
      { origins: ['*'] }, { origins: ['https://app.example/path'] }, { credentials: 'include' },
      { methods: ['*'] }, { headers: ['X-Bad\r\nInjected'] }, { maxAge: 86401 }, { options: () => 204 },
    ]) expect(() => composition([{ ...policy, ...invalid } as ExactRouteCorsPolicy])).toThrow();
  });
});
