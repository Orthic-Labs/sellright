import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHttpApp } from './app.js';
import { poolsInitialised } from './db/client.js';
import { CACHE_ADMIN_TOKEN_HEADER } from './routes/admin-cache.js';

// Exercise the real app middleware, OpenAPI validation, agent guard & cache handler.
// Only external state is replaced: no Postgres, maintenance file or Cloudflare call.
const state = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'test', DEBUG_ERRORS: '0', API_BODY_LIMIT_BYTES: 1024,
    CACHE_ADMIN_TOKEN: 'cache-test-secret' as string | undefined,
  },
  retryAfter: vi.fn().mockResolvedValue(0),
  resolveAdmin: vi.fn().mockResolvedValue(null),
}));
vi.mock('./env.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./env.js')>(), env: state.env,
}));
vi.mock('./auth/rate-limit.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./auth/rate-limit.js')>(), attemptRetryAfter: state.retryAfter,
}));
vi.mock('./auth/admin-session.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./auth/admin-session.js')>(), resolveAdmin: state.resolveAdmin,
}));
vi.mock('./cors-origins.js', () => ({ isAllowedCorsOrigin: async () => false, isAllowedAdminCorsOrigin: () => false }));
vi.mock('./maintenance.js', () => ({ isMaintenanceOn: () => false, maintenanceInfo: () => ({ maintenance: false }) }));

const PATH = '/v1/admin/cache/purge';
const TOKEN = 'cache-test-secret';

function request(app: ReturnType<typeof buildHttpApp>, headers: Record<string, string> = {}, path = PATH, method = 'POST', body = JSON.stringify({ storeSlug: 'unconfigured-store' })) {
  return app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body });
}

beforeEach(() => {
  state.env.CACHE_ADMIN_TOKEN = TOKEN;
  state.retryAfter.mockReset().mockResolvedValue(0);
  state.resolveAdmin.mockReset().mockResolvedValue(null);
});

describe('full-app cache-purge machine credential & CSRF boundary', () => {
  it('accepts only content-type plus cache token, with no bearer/session/CSRF, when Cloudflare is unconfigured', async () => {
    const res = await request(buildHttpApp(), { [CACHE_ADMIN_TOKEN_HEADER]: TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, purged: false, reason: 'no Cloudflare zone/token configured for this store' });
    expect(state.retryAfter).toHaveBeenCalledOnce();
    expect(state.retryAfter).toHaveBeenCalledWith('unknown', 'cache-purge');
    expect(state.resolveAdmin).not.toHaveBeenCalled();
    expect(poolsInitialised()).toBe(false);
  });

  it.each(['wrong', 'cache-test-secrex'])('rejects incorrect machine token %s in the handler', async (token) => {
    const res = await request(buildHttpApp(), { [CACHE_ADMIN_TOKEN_HEADER]: token });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { message: 'invalid or missing cache admin token' } });
    expect(state.retryAfter).not.toHaveBeenCalled();
  });

  it('rejects a missing token at admission & never uses a session cookie as cache authorization', async () => {
    const app = buildHttpApp();
    expect((await request(app)).status).toBe(401);
    const res = await request(app, { cookie: 'sr_admin=present' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { message: 'invalid or missing cache admin token' } });
    expect(state.resolveAdmin).toHaveBeenCalledWith('present');
    expect(state.retryAfter).not.toHaveBeenCalled();
    expect(poolsInitialised()).toBe(false);
  });

  it('fails closed when the machine token is unconfigured', async () => {
    state.env.CACHE_ADMIN_TOKEN = undefined;
    const res = await request(buildHttpApp(), { [CACHE_ADMIN_TOKEN_HEADER]: TOKEN });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { message: 'CACHE_ADMIN_TOKEN is not configured' } });
    expect(state.retryAfter).not.toHaveBeenCalled();
  });

  it('keeps the shared rate limiter after authentication', async () => {
    state.retryAfter.mockResolvedValue(42);
    const res = await request(buildHttpApp(), { [CACHE_ADMIN_TOKEN_HEADER]: TOKEN });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
  });

  it('keeps the global body cap before the handler', async () => {
    const res = await request(buildHttpApp(), { [CACHE_ADMIN_TOKEN_HEADER]: TOKEN }, PATH, 'POST', JSON.stringify({ storeSlug: 'x'.repeat(2048) }));
    expect(res.status).toBe(413);
    expect(state.retryAfter).not.toHaveBeenCalled();
  });

  it.each([
    ['/v1/admin/staff', 'POST'],
    [PATH + '/extra', 'POST'],
    [PATH + '/', 'POST'],
    [PATH + '-extra', 'POST'],
    ['/v1/admin/cache/%70urge', 'POST'],
    [PATH, 'PUT'],
    [PATH, 'PATCH'],
    [PATH, 'DELETE'],
  ])('retains cookie CSRF on %s %s even with a cache token', async (path, method) => {
    const res = await request(buildHttpApp(), { cookie: 'sr_admin=present', [CACHE_ADMIN_TOKEN_HEADER]: TOKEN }, path, method);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'CSRF_INVALID' } });
    expect(state.retryAfter).not.toHaveBeenCalled();
    expect(state.resolveAdmin).not.toHaveBeenCalled();
  });
});
