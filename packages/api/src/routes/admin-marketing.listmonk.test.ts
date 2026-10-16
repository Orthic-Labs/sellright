import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  role: 'owner',
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
      for: async () => rows(),
    });
    return run({
      select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
      update: () => ({ set: (value: { config: Record<string, unknown> }) => ({ where: async () => {
        mocks.save(value);
        mocks.config = value.config;
      } }) }),
    });
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config = { otherSetting: true };
    mocks.role = 'owner';
    mocks.assertSafe.mockReset().mockImplementation(async (url: string) => url);
    mocks.fetch.mockReset().mockImplementation(async (url: string) => Response.json(
      url.endsWith('/api/lists') ? { data: { total: 3 } } : { data: { id: Number(url.split('/').at(-1)) } },
    ));
  });

  it('verifies & persists an explicitly chosen list without dropping other store settings', async () => {
    expect((await patch({ ...connection, listId: 7 })).status).toBe(200);
    expect(mocks.assertSafe).toHaveBeenCalledWith(connection.url);
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
