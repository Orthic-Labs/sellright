import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as Array<{ id: string }>, tenantUsed: '' as string }));

vi.mock('../db/client.js', () => ({
  withStore: vi.fn(async (storeId: string, fn: (tx: unknown) => unknown) => {
    state.tenantUsed = storeId;
    return fn({ select: () => ({ from: () => ({ where: () => ({ orderBy: async () => state.rows }) }) }) });
  }),
}));

import { createLicenseRevocationFeed } from './revocation-feed.js';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-09T12:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('tenant-bound revocation feed', () => {
  it('returns the frozen body shape with the tenant chosen by the resolver', async () => {
    const app = createLicenseRevocationFeed({ resolveTenant: async () => ({ id: 'store-1' }) });
    state.rows = [{ id: '11111111-1111-4111-8111-111111111111' }, { id: '22222222-2222-4222-8222-222222222222' }];
    const res = await app.request('/v1/pro/revocations');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await res.text()).toBe('{"ids":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"],"updatedAt":"2026-10-09T12:00:00.000Z"}');
    expect(state.tenantUsed).toBe('store-1');
  });

  it('is read-only and ignores credentials', async () => {
    const app = createLicenseRevocationFeed({ resolveTenant: async () => ({ id: 'store-1' }) });
    state.rows = [];
    expect((await app.request('/v1/pro/revocations', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/v1/pro/revocations', { headers: { authorization: 'Bearer anything' } })).status).toBe(200);
  });
});
