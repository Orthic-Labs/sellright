import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), marked: vi.fn(), released: vi.fn(), lockQuery: vi.fn(), active: 0,
  tick: 0, mode: 'fair' as 'fair' | 'stalled' | 'prior-success',
  claimedStores: [] as string[], readbackTicks: [] as number[],
  requests: [] as { store: string; method: string; path: string; tick: number; at: number }[],
}));
vi.mock('../security/outbound-url.js', () => ({ safeOutboundFetch: mocks.fetch }));
vi.mock('../db/client.js', () => ({
  pool: {
    connect: async () => ({ query: mocks.lockQuery, release: mocks.released }),
    query: async () => ({ rows: [{ id: 'first', slug: 'first' }, { id: 'second', slug: 'second' }] }),
  },
  withStore: async (storeId: string, run: (tx: unknown) => Promise<unknown>) => run({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ config: { listmonk: {
      url: `https://${storeId}.example.test`, apiUser: 'user', apiToken: 'token', listId: 7,
    } } }] }) }) }),
    execute: async () => {
      mocks.claimedStores.push(storeId);
      // First store keeps returning its oldest stalled batch; second gets fresh work each tick.
      const tick = storeId === 'first' ? 0 : mocks.tick;
      const length = storeId === 'first' || mocks.mode === 'stalled' ? 200 : 1;
      return { rows: Array.from({ length }, (_, index) => ({
        id: `id:${storeId}:${tick}:${index}`, email: `${storeId}-${tick}-${index}@example.test`,
        name: null, kind: 'newsletter', topic: '',
      })) };
    },
    update: () => ({ set: () => ({ where: async (predicate: SQL) => {
      const ids = new PgDialect().sqlToQuery(predicate).params.flat(Infinity)
        .filter((value): value is string => typeof value === 'string' && value.startsWith('id:'));
      if (storeId === 'second') expect(mocks.readbackTicks).toContain(mocks.tick);
      mocks.marked(storeId, ids);
    } }) }),
  }),
}));
import { listmonkSync } from './listmonk-sync.js';
import { withLeaderLock } from './leader-lock.js';

function confirmed(id: number, email: string) {
  return { id, email, status: 'enabled', lists: [{ id: 7, subscription_status: 'confirmed' }] };
}
function stall(signal: AbortSignal): Promise<Response> {
  mocks.active++;
  let onAbort: () => void;
  return new Promise<Response>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }).finally(() => {
    signal.removeEventListener('abort', onAbort);
    mocks.active--;
  });
}
function installProvider() {
  mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const store = parsed.hostname.split('.')[0]!;
    const method = init.method ?? 'GET';
    mocks.requests.push({ store, method, path: parsed.pathname, tick: mocks.tick, at: performance.now() });
    if (store === 'first' || mocks.mode === 'stalled') {
      const body = method === 'POST' ? JSON.parse(init.body as string) as { email: string } : undefined;
      if (mocks.mode === 'prior-success' && body?.email === 'first-0-0@example.test') {
        return Response.json({ data: confirmed(12, body.email) });
      }
      return stall(init.signal!);
    }
    const email = `second-${mocks.tick}-0@example.test`;
    const id = 100 + mocks.tick;
    if (method === 'POST') return new Response(null, { status: 409 });
    if (parsed.searchParams.has('query')) {
      return Response.json({ data: { results: [{ id, email, status: 'enabled', lists: [] }] } });
    }
    if (method === 'PUT' && parsed.pathname === '/api/subscribers/query/lists') return Response.json({ data: true });
    if (method === 'GET' && parsed.pathname === `/api/subscribers/${id}`) {
      mocks.readbackTicks.push(mocks.tick);
      return Response.json({ data: confirmed(id, email) });
    }
    throw new Error(`unexpected provider request: ${method} ${parsed.pathname}`);
  });
}
function expectClosed(ticks: number) {
  expect(mocks.active).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(mocks.released).toHaveBeenCalledTimes(ticks);
  expect(mocks.lockQuery.mock.calls.filter(([query]) => String(query).includes('pg_advisory_unlock'))).toHaveLength(ticks);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  vi.clearAllMocks(); mocks.fetch.mockReset(); mocks.active = 0; mocks.tick = 0; mocks.mode = 'fair';
  mocks.claimedStores = []; mocks.readbackTicks = []; mocks.requests = [];
  mocks.lockQuery.mockResolvedValue({ rows: [{ locked: true }] });
  installProvider();
});
afterEach(() => vi.useRealTimers());

describe('Listmonk fair provider-work budget', () => {
  it('serves fresh later-store work on two ticks despite 200 persistently stalled oldest rows', async () => {
    for (let tick = 0; tick < 2; tick++) {
      mocks.tick = tick;
      const start = performance.now();
      const operation = withLeaderLock('listmonk-sync', () => listmonkSync());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await operation).toMatchObject({ synced: 1, failed: 3 });
      const later = mocks.requests.filter(request => request.store === 'second' && request.tick === tick);
      expect(later.map(request => `${request.method} ${request.path}`)).toEqual([
        'POST /api/subscribers', 'GET /api/subscribers',
        'PUT /api/subscribers/query/lists', `GET /api/subscribers/${100 + tick}`,
      ]);
      expect(later[0]!.at - start).toBe(30_000);
      expect(mocks.marked).toHaveBeenNthCalledWith(tick + 1, 'second', [`id:second:${tick}:0`]);
      expectClosed(tick + 1);
    }
    expect(mocks.claimedStores).toEqual(['first', 'second', 'first', 'second']);
    expect(mocks.readbackTicks).toEqual([0, 1]);
    const requests = mocks.requests.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mocks.requests).toHaveLength(requests);
    expectClosed(2);
  });

  it('attempts both stores within 60s when every provider request stalls', async () => {
    mocks.mode = 'stalled';
    const operation = withLeaderLock('listmonk-sync', () => listmonkSync());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await operation).toMatchObject({ synced: 0, failed: 6 });
    expect(mocks.requests.filter(request => request.store === 'first').map(request => request.at)).toEqual([0, 10_000, 20_000]);
    expect(mocks.requests.filter(request => request.store === 'second').map(request => request.at)).toEqual([30_000, 40_000, 50_000]);
    expect(mocks.marked).not.toHaveBeenCalled();
    expectClosed(1);
  });

  it('persists only proven earlier successes after store expiry before serving next store', async () => {
    mocks.mode = 'prior-success';
    const operation = withLeaderLock('listmonk-sync', () => listmonkSync());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await operation).toMatchObject({ synced: 2, failed: 3 });
    expect(mocks.marked.mock.calls).toEqual([
      ['first', ['id:first:0:0']], ['second', ['id:second:0:0']],
    ]);
    expect(mocks.readbackTicks).toEqual([0]);
    expectClosed(1);
  });
});
