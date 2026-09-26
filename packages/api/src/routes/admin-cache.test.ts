/**
 * Unit tests for the internal Cloudflare cache-purge route
 * (POST /v1/admin/cache/purge). No database needed — auth is a shared token,
 * not an admin session, and the Cloudflare/rate-limit dependencies are
 * mocked. Covers:
 *   - fail CLOSED (503) when CACHE_ADMIN_TOKEN isn't configured
 *   - 401 on a missing/wrong token (constant-time compare, not ===)
 *   - 429 when the shared rate limiter says to back off
 *   - 200 purged:true / purged:false for a configured vs unconfigured store
 *   - explicit `urls` in the body bypasses the "standard set" and purges exactly those
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';

const { envMock, purgeSpy, resolveConfigSpy, standardUrlsSpy, retryAfterSpy } = vi.hoisted(() => ({
  envMock: {} as Record<string, string | undefined>,
  purgeSpy: vi.fn().mockResolvedValue(true),
  resolveConfigSpy: vi.fn(),
  standardUrlsSpy: vi.fn(),
  retryAfterSpy: vi.fn().mockReturnValue(0),
}));

vi.mock('../env.js', () => ({ env: envMock }));
vi.mock('../cache/cloudflare-purge.js', () => ({
  purgeCloudflareUrls: (...a: unknown[]) => purgeSpy(...a),
  resolveCloudflareConfig: (...a: unknown[]) => resolveConfigSpy(...a),
}));
vi.mock('../cache/purge-hook.js', () => ({
  standardPurgeUrls: (...a: unknown[]) => standardUrlsSpy(...a),
}));
vi.mock('../auth/rate-limit.js', () => ({
  attemptRetryAfter: (...a: unknown[]) => retryAfterSpy(...a),
  clientIp: () => '1.2.3.4',
}));

import { adminCache, CACHE_ADMIN_TOKEN_HEADER } from './admin-cache.js';

const app = new OpenAPIHono();
app.route('/', adminCache);

async function purge(body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers[CACHE_ADMIN_TOKEN_HEADER] = token;
  const res = await app.request('/v1/admin/cache/purge', { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
  purgeSpy.mockClear().mockResolvedValue(true);
  resolveConfigSpy.mockClear().mockReturnValue({ zoneId: 'z', apiToken: 't' });
  standardUrlsSpy.mockClear().mockReturnValue(['https://acme.example.com/', 'https://acme.example.com/shop/']);
  retryAfterSpy.mockClear().mockReturnValue(0);
});

describe('POST /v1/admin/cache/purge', () => {
  it('fails closed (503) when CACHE_ADMIN_TOKEN is not configured', async () => {
    const { status, body } = await purge({ storeSlug: 'acme' }, 'anything');
    expect(status).toBe(503);
    expect((body as { error: string }).error).toMatch(/not configured/i);
  });

  it('rejects a missing token (401)', async () => {
    envMock.CACHE_ADMIN_TOKEN = 'right-token';
    const { status } = await purge({ storeSlug: 'acme' });
    expect(status).toBe(401);
  });

  it('rejects a wrong token, including one of a different length (401, no crash)', async () => {
    envMock.CACHE_ADMIN_TOKEN = 'right-token';
    expect((await purge({ storeSlug: 'acme' }, 'wrong')).status).toBe(401);
    expect((await purge({ storeSlug: 'acme' }, 'a-much-longer-wrong-token-value')).status).toBe(401);
  });

  it('rate limits (429) with a Retry-After header when the limiter says to back off', async () => {
    envMock.CACHE_ADMIN_TOKEN = 'right-token';
    retryAfterSpy.mockReturnValue(42);
    const res = await app.request('/v1/admin/cache/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CACHE_ADMIN_TOKEN_HEADER]: 'right-token' },
      body: JSON.stringify({ storeSlug: 'acme' }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(purgeSpy).not.toHaveBeenCalled();
  });

  it('purges the standard URL set for a configured store with the right token', async () => {
    envMock.CACHE_ADMIN_TOKEN = 'right-token';
    const { status, body } = await purge({ storeSlug: 'acme' }, 'right-token');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, purged: true });
    expect(purgeSpy).toHaveBeenCalledWith('acme', ['https://acme.example.com/', 'https://acme.example.com/shop/']);
  });

  it('purges exactly the given urls when the body includes them, skipping the standard set', async () => {
    envMock.CACHE_ADMIN_TOKEN = 'right-token';
    const { status, body } = await purge({ storeSlug: 'acme', urls: ['https://acme.example.com/products/widget/'] }, 'right-token');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, purged: true });
    expect(purgeSpy).toHaveBeenCalledWith('acme', ['https://acme.example.com/products/widget/']);
    expect(standardUrlsSpy).not.toHaveBeenCalled();
  });

  it('reports purged:false without calling Cloudflare when the store has no config', async () => {
    envMock.CACHE_ADMIN_TOKEN = 'right-token';
    resolveConfigSpy.mockReturnValue(null);
    const { status, body } = await purge({ storeSlug: 'unconfigured-store' }, 'right-token');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, purged: false, reason: expect.stringContaining('no Cloudflare') });
    expect(purgeSpy).not.toHaveBeenCalled();
  });
});
