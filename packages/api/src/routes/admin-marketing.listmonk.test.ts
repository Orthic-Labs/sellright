import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  role: 'owner',
  locked: false,
  customers: [] as Array<{ email: string; firstName: string; lastName: string }>,
  audit: vi.fn(),
  save: vi.fn(),
  fetch: vi.fn(),
  assertSafe: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('../db/client.js', () => ({
  withStore: vi.fn(async (_storeId: string, run: (tx: unknown) => Promise<unknown>) => {
    const rows = () => [{ config: mocks.config }];
    const limit = () => ({
      then: (resolve: (value: ReturnType<typeof rows>) => unknown) => Promise.resolve(rows()).then(resolve),
      for: async () => { mocks.locked = true; return rows(); },
    });
    try { return await run({
      select: (fields: Record<string, unknown>) => ({ from: () => ({ where: () => ({ limit: 'email' in fields ? async () => mocks.customers : limit }) }) }),
      insert: () => ({ values: async (value: unknown) => mocks.audit(value) }),
      update: () => ({ set: (value: { config: Record<string, unknown> }) => ({ where: async () => {
        mocks.save(value);
        mocks.config = value.config;
      } }) }),
    }); } finally { mocks.locked = false; }
  }),
}));
vi.mock('../security/outbound-url.js', () => ({ safeOutboundFetch: mocks.fetch, assertSafeOutboundUrl: mocks.assertSafe }));
vi.mock('../store-context.js', () => ({ broadcastStoreCacheInvalidation: mocks.invalidate }));
vi.mock('../affiliate/onboarding.js', () => ({ syncPromotionAffiliate: vi.fn() }));
vi.mock('./admin-helpers.js', async () => {
  const { z } = await import('@hono/zod-openapi');
  class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
  }
  return {
    HttpError, J: (schema: unknown) => ({ 'application/json': { schema } }), errBody: {}, money: z.number(), Page: z.any(),
    requireAdmin: async () => ({ admin: {} }), requireStore: () => ({ storeId: 'store-1', slug: 'store-1', role: mocks.role }),
    requireManage: () => { if (mocks.role !== 'owner') throw new HttpError(403, 'forbidden'); },
    requireWrite: vi.fn(), requireHuman: vi.fn(), requirePermission: vi.fn(),
    guard: async (c: { json: (value: unknown, status: number) => unknown }, fn: () => Promise<unknown>) => {
      try { return await fn(); } catch (error) {
        if (error instanceof HttpError) return c.json({ error: { message: error.message } }, error.status);
        throw error;
      }
    },
  };
});

import { adminMarketing } from './admin-marketing.js';

const connection = { url: 'https://listmonk.example.com', apiUser: 'api-user', apiToken: 'secret-token' };
const patch = (body: object) => adminMarketing.request('/v1/admin/marketing/config', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('Listmonk signup list configuration', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config = { otherSetting: true };
    mocks.role = 'owner';
    mocks.locked = false; mocks.customers = [];
    mocks.assertSafe.mockReset().mockImplementation(async (url: string) => url);
    mocks.fetch.mockReset().mockImplementation(async (url: string) => Response.json(
      url.endsWith('/api/lists') ? { data: { total: 3 } } : { data: { id: Number(url.split('/').at(-1)) } },
    ));
  });

  it('verifies & persists an explicitly chosen list without dropping other store settings', async () => {
    expect((await patch({ ...connection, listId: 7 })).status).toBe(200);
    expect(mocks.assertSafe).toHaveBeenCalledWith(connection.url, { signal: expect.any(AbortSignal) });
    expect(mocks.fetch).toHaveBeenCalledWith(`${connection.url}/api/lists/7`, expect.objectContaining({
      headers: expect.objectContaining({ authorization: `Basic ${Buffer.from('api-user:secret-token').toString('base64')}` }),
    }));
    expect(mocks.config).toEqual({ otherSetting: true, listmonk: { ...connection, listId: 7 } });
    expect(mocks.invalidate).toHaveBeenCalledWith('store-1');
  });

  it('preserves a saved list ID when an existing connection update omits it', async () => {
    mocks.config.listmonk = { ...connection, listId: 9 };
    expect((await patch({ ...connection, apiToken: 'replacement' })).status).toBe(200);
    expect(mocks.config.listmonk).toEqual({ ...connection, apiToken: 'replacement', listId: 9 });
  });

  it('requires an explicit target for a new or legacy connection lacking a list ID', async () => {
    expect((await patch(connection)).status).toBe(409);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, '7', null])('rejects invalid list ID %s before saving', async (listId) => {
    expect((await patch({ ...connection, listId })).status).toBeGreaterThanOrEqual(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('keeps previous configuration when the provider cannot verify the target', async () => {
    mocks.config.listmonk = { ...connection, listId: 9 };
    mocks.fetch.mockResolvedValueOnce(Response.json({ data: { total: 3 } }))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));
    expect((await patch({ ...connection, listId: 7 })).status).toBe(409);
    expect(mocks.config.listmonk).toEqual({ ...connection, listId: 9 });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('returns signup destination without exposing credentials & identifies legacy missing targets', async () => {
    mocks.config.listmonk = { ...connection, listId: 7 };
    const get = () => adminMarketing.request('/v1/admin/marketing/config');
    expect(await (await get()).json()).toEqual({ configured: true, url: connection.url, listId: 7 });
    mocks.config.listmonk = connection;
    expect(await (await get()).json()).toEqual({ configured: true, url: connection.url, listId: null });
  });

  it('keeps connection changes behind management permission', async () => {
    mocks.role = 'read_only';
    expect((await patch({ ...connection, listId: 7 })).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe('Listmonk configuration verification races', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks(); mocks.role = 'owner'; mocks.locked = false;
    mocks.config = { otherSetting: true, listmonk: { ...connection, listId: 9 } };
    mocks.assertSafe.mockReset().mockImplementation(async (url: string) => url);
  });

  it.each(['url', 'apiUser', 'apiToken', 'listId'] as const)('refuses concurrent remote %s changes without overwriting them', async key => {
    mocks.fetch.mockReset().mockImplementation(async (url: string) => {
      expect(mocks.locked).toBe(false);
      if (url.endsWith('/api/lists/9')) {
        mocks.config = { otherSetting: 'new', listmonk: { ...connection, listId: 9, [key]: key === 'listId' ? 11 : 'changed' } };
      }
      return Response.json(url.endsWith('/api/lists') ? { data: { total: 3 } } : { data: { id: 9 } });
    });
    expect((await patch({ ...connection, apiToken: 'replacement' })).status).toBe(409);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect((mocks.config.listmonk as Record<string, unknown>)[key]).toBe(key === 'listId' ? 11 : 'changed');
  });

  it('merges latest unrelated settings after verification outside the row lock', async () => {
    mocks.fetch.mockReset().mockImplementation(async (url: string) => {
      expect(mocks.locked).toBe(false);
      mocks.config = { ...mocks.config, otherSetting: 'concurrent' };
      return Response.json(url.endsWith('/api/lists') ? { data: { total: 3 } } : { data: { id: 9 } });
    });
    expect((await patch({ ...connection, apiToken: 'replacement' })).status).toBe(200);
    expect(mocks.config).toEqual({ otherSetting: 'concurrent', listmonk: { ...connection, apiToken: 'replacement', listId: 9 } });
  });

  it('aborts a stalled provider check before ever taking the row lock', async () => {
    vi.useFakeTimers();
    let active = 0;
    mocks.fetch.mockReset().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      active++;
      init.signal!.addEventListener('abort', () => { active--; reject(init.signal!.reason); }, { once: true });
    }));
    const result = patch({ ...connection, listId: 7 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).status).toBe(500);
    expect(active).toBe(0); expect(mocks.locked).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('manual Listmonk sync provider-work deadline', () => {
  afterEach(() => vi.useRealTimers());
  it('counts remaining rows as failed without continuing outbound work after 60s', async () => {
    vi.useFakeTimers(); vi.clearAllMocks(); mocks.role = 'owner'; mocks.locked = false;
    mocks.config = { listmonk: { ...connection, listId: 7 } };
    mocks.customers = Array.from({ length: 200 }, (_, index) => ({ email: `${index}@example.test`, firstName: '', lastName: '' }));
    let active = 0;
    mocks.fetch.mockReset().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      active++;
      init.signal!.addEventListener('abort', () => { active--; reject(init.signal!.reason); }, { once: true });
    }));
    const operation = adminMarketing.request('/v1/admin/marketing/sync', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listId: 7 }),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const response = await operation;
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ synced: 0, failed: 200 });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ storeId: 'store-1', data: { synced: 0, failed: 200 } }));
    expect(mocks.fetch).toHaveBeenCalledTimes(6); expect(active).toBe(0); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000); expect(mocks.fetch).toHaveBeenCalledTimes(6);
  });
});
