import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  stores: [] as string[],
  rows: new Map<string, Array<{ id: string; topic: string; payload: unknown; url: string; secret: string; attempts: number; status: string; nextAttemptAt: number }>>(),
  minute: 0,
  now: 0,
  cutoff: '2000-01-01T00:00:00.000Z',
  claims: [] as string[],
  statements: [] as string[],
  finalized: [] as string[],
  finalizers: new Map<string, () => Promise<void>>(),
  failStores: new Set<string>(),
  configs: [] as Array<Record<string, unknown>>,
  transactionOptions: [] as unknown[],
  enumConfig: undefined as unknown,
  enumError: undefined as Error | undefined,
  connectError: undefined as Error | undefined,
  poolError: undefined as Error | undefined,
  expireDuring: undefined as 'enumeration' | 'connect' | undefined,
  connections: 0,
  closeGate: undefined as Promise<void> | undefined,
  endCalls: 0,
  unlocked: false,
  leaderReleased: false,
}));

vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  class MockClient extends EventEmitter {
    release = vi.fn((_broken?: boolean) => undefined);
    private closing?: Promise<void>;
    end(): Promise<void> {
      if (!this.closing) {
        h.endCalls++;
        this.closing = (h.closeGate ?? Promise.resolve()).then(() => { this.emit('end'); });
      }
      return this.closing;
    }
  }
  class MockPool extends EventEmitter {
    private clients: MockClient[] = [];
    constructor(private config: Record<string, unknown> & { Client: new () => MockClient }) {
      super(); h.configs.push(config);
    }
    async connect() {
      h.connections++;
      if (h.expireDuring === 'connect' && h.connections > 1) h.now = 40_001;
      const client = new this.config.Client();
      this.clients.push(client);
      if (h.connectError) { void client.end(); throw h.connectError; }
      return client;
    }
    async query(config: unknown) {
      h.enumConfig = config;
      const client = await this.connect();
      if (h.expireDuring === 'enumeration') h.now = 40_001;
      if (h.poolError) this.emit('error', h.poolError);
      if (h.enumError) { client.release(true); void client.end(); throw h.enumError; }
      client.release();
      return { rows: h.stores.map((id) => ({ id, cutoff: h.cutoff, minuteOrdinal: h.minute })) };
    }
    async end() {
      // Match pg-pool's early removal: pool.end alone is insufficient evidence
      // that every previously removed client's physical close has settled.
      for (const client of this.clients) void client.end();
    }
  }
  return { Client: MockClient, Pool: MockPool };
});

vi.mock('../db/client.js', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();
  return {
    pool: {
      connect: async () => ({
        query: async (text: string) => {
          if (text.includes('pg_advisory_unlock')) h.unlocked = true;
          return { rows: [{ locked: true }] };
        },
        release: () => { h.leaderReleased = true; },
      }),
    },
    runStoreTransaction: async (
      client: { release: () => void }, storeId: string,
      fn: (tx: unknown) => Promise<unknown>, _factory: unknown, options: unknown,
    ) => {
      h.transactionOptions.push(options);
      try {
        return await fn({
          execute: async (query: SQL) => {
            const statement = dialect.sqlToQuery(query);
            h.statements.push(statement.sql);
            h.claims.push(storeId);
            if (h.failStores.has(storeId)) throw new Error(`claim failed: ${storeId}`);
            expect(statement.params).toEqual([storeId, storeId, storeId, h.cutoff]);
            const cutoff = Date.parse(String(statement.params[3]));
            const row = h.rows.get(storeId)?.find((r) => r.status === 'pending' && r.nextAttemptAt <= cutoff);
            if (!row) return { rows: [] };
            row.status = 'processing'; row.attempts++;
            return { rows: [{ ...row }] };
          },
          update: () => ({ set: (values: { status: string; nextAttemptAt?: Date }) => ({
            where: async (condition: SQL) => {
              await h.finalizers.get(storeId)?.();
              const row = h.rows.get(storeId)?.find((r) => r.status === 'processing');
              if (!row) throw new Error('No claimed row');
              expect(dialect.sqlToQuery(condition).params).toEqual([storeId, row.id]);
              row.status = values.status;
              if (values.nextAttemptAt) row.nextAttemptAt = values.nextAttemptAt.getTime();
              h.finalized.push(row.id);
            },
          }) }),
        });
      } finally { client.release(); }
    },
  };
});
vi.mock('../security/outbound-url.js', () => ({ safeOutboundFetch: vi.fn() }));

import { safeOutboundFetch } from '../security/outbound-url.js';
import { withLeaderLock } from '../jobs/leader-lock.js';
import { deliverWebhooks, normalizeWebhookBatchLimit } from './emit.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
function seed(storeId: string, count: number) {
  h.rows.set(storeId, Array.from({ length: count }, (_, i) => ({
    id: `${storeId}-${i}`, topic: 'order.created', payload: { ok: true },
    url: `https://${storeId}.example/hook`, secret: 'test-secret', attempts: 0,
    status: 'pending', nextAttemptAt: 0,
  })));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.stores = []; h.rows.clear(); h.minute = 0; h.now = 0;
  h.claims = []; h.statements = []; h.finalized = []; h.finalizers.clear(); h.failStores.clear();
  h.configs = []; h.transactionOptions = []; h.enumConfig = undefined;
  h.enumError = undefined; h.connectError = undefined; h.poolError = undefined; h.closeGate = undefined;
  h.expireDuring = undefined; h.connections = 0;
  h.endCalls = 0; h.unlocked = false; h.leaderReleased = false;
  vi.spyOn(performance, 'now').mockImplementation(() => h.now);
  vi.mocked(safeOutboundFetch).mockResolvedValue(new Response(null, { status: 200 }));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('normalizeWebhookBatchLimit', () => {
  it('defaults to 50 for absent or invalid limits', () => {
    expect(normalizeWebhookBatchLimit()).toBe(50);
    expect(normalizeWebhookBatchLimit(Number.NaN)).toBe(50);
    expect(normalizeWebhookBatchLimit(Number.POSITIVE_INFINITY)).toBe(50);
  });
  it('clamps to a safe inclusive range', () => {
    expect(normalizeWebhookBatchLimit(0)).toBe(1);
    expect(normalizeWebhookBatchLimit(10.8)).toBe(10);
    expect(normalizeWebhookBatchLimit(2000)).toBe(500);
  });
});

describe('webhook pass fairness & lifetime', () => {
  it('finalizes healthy B before first stalled A completes, with global <=2 & per-store <=1 HTTP', async () => {
    h.stores = ['a', 'b']; seed('a', 50); seed('b', 3);
    const stalled = deferred();
    const active = new Map<string, number>();
    let total = 0; let peak = 0; let perStorePeak = 0;
    vi.mocked(safeOutboundFetch).mockImplementation(async (url) => {
      const store = new URL(url).hostname[0]!;
      total++; active.set(store, (active.get(store) ?? 0) + 1);
      peak = Math.max(peak, total); perStorePeak = Math.max(perStorePeak, active.get(store)!);
      try {
        if (store === 'a') await stalled.promise;
        return new Response(null, { status: 200 });
      } finally { total--; active.set(store, active.get(store)! - 1); }
    });
    const work = deliverWebhooks();
    await settle();
    expect(h.finalized).toEqual(['b-0', 'b-1', 'b-2']);
    expect(h.rows.get('a')!.filter((r) => r.status === 'processing')).toHaveLength(1);
    expect(h.rows.get('a')!.filter((r) => r.status === 'pending')).toHaveLength(49);
    stalled.resolve();
    expect(await work).toEqual({ delivered: 53, failed: 0 });
    expect(peak).toBe(2); expect(perStorePeak).toBe(1);
    expect(h.configs[0]).toMatchObject({ max: 2, connectionTimeoutMillis: 1000, statement_timeout: 1000, lock_timeout: 250, pipeline: false });
    expect(h.transactionOptions.every((options) => JSON.stringify(options) === '{"timeoutMs":2000}')).toBe(true);
    expect(h.statements.every((text) => text.includes('ORDER BY next_attempt_at, id') && text.includes('LIMIT 1'))).toBe(true);
  });

  it('requeues stores in FIFO order & rotates from DB minute in each fresh pass', async () => {
    h.stores = ['a', 'b', 'c'];
    for (const store of h.stores) seed(store, 2);
    await deliverWebhooks({ limit: 2 });
    expect(h.claims).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    h.claims = []; h.minute = 1;
    for (const store of h.stores) seed(store, 1);
    await deliverWebhooks({ limit: 1 });
    expect(h.claims).toEqual(['b', 'c', 'a']);
    h.claims = [];
    for (const store of h.stores) seed(store, 1);
    await deliverWebhooks({ limit: 1 });
    expect(h.claims).toEqual(['b', 'c', 'a']);
    expect(h.enumConfig).toMatchObject({ query_timeout: 1500 });
  });

  it('leaves queued rows byte-identical at deadline & drains accepted finalizers', async () => {
    h.stores = ['a', 'b', 'c']; for (const store of h.stores) seed(store, 1);
    const before = JSON.stringify(h.rows.get('c'));
    const accepted = deferred();
    vi.mocked(safeOutboundFetch).mockImplementation(async () => {
      h.now = 40_001; await accepted.promise;
      return new Response(null, { status: 200 });
    });
    const work = deliverWebhooks();
    await settle();
    expect(h.claims).toEqual(['a', 'b']);
    expect(h.finalized).toEqual([]);
    accepted.resolve();
    expect(await work).toEqual({ delivered: 2, failed: 0 });
    expect(JSON.stringify(h.rows.get('c'))).toBe(before);
  });

  it('does not retry a failed row during the same pass after 30s elapse', async () => {
    h.stores = ['a']; seed('a', 1);
    vi.mocked(safeOutboundFetch).mockImplementation(async () => {
      h.now = 31_000; return new Response(null, { status: 503 });
    });
    expect(await deliverWebhooks()).toEqual({ delivered: 0, failed: 0 });
    expect(safeOutboundFetch).toHaveBeenCalledTimes(1);
    expect(h.rows.get('a')![0]).toMatchObject({ attempts: 1, status: 'pending' });
  });

  it('keeps leader held while another worker fails & accepted finalization/cleanup are pending', async () => {
    h.stores = ['a', 'b']; seed('a', 1); seed('b', 1); h.failStores.add('b');
    const finalizer = deferred(); const close = deferred();
    h.finalizers.set('a', () => finalizer.promise); h.closeGate = close.promise;
    const work = withLeaderLock('webhooks', () => deliverWebhooks({ limit: 1 }));
    const rejected = expect(work).rejects.toThrow('Webhook delivery pass failed');
    await settle();
    expect(h.unlocked).toBe(false); expect(h.leaderReleased).toBe(false);
    finalizer.resolve(); await settle();
    expect(h.finalized).toEqual(['a-0']);
    expect(h.unlocked).toBe(false); expect(h.endCalls).toBeGreaterThan(0);
    close.resolve(); await rejected;
    expect(h.unlocked).toBe(true); expect(h.leaderReleased).toBe(true);
  });

  it.each(['enumeration', 'connect'] as const)('drains physical close on %s failure before throwing', async (kind) => {
    const close = deferred(); h.closeGate = close.promise;
    if (kind === 'enumeration') h.enumError = new Error('Query read timeout');
    else h.connectError = new Error('Connection terminated due to connection timeout');
    let finished = false;
    const work = deliverWebhooks().finally(() => { finished = true; });
    const rejected = expect(work).rejects.toThrow('Webhook delivery pass failed');
    await settle();
    expect(finished).toBe(false); expect(h.endCalls).toBe(1);
    expect(h.claims).toEqual([]); expect(safeOutboundFetch).not.toHaveBeenCalled();
    close.resolve(); await rejected;
    expect(finished).toBe(true);
  });
});


describe('webhook admission & pool errors', () => {
  it.each(['enumeration', 'connect'] as const)('rechecks admission after %s consumes remaining time', async (phase) => {
    h.stores = ['a']; seed('a', 1); h.expireDuring = phase;
    const before = JSON.stringify(h.rows.get('a'));
    expect(await deliverWebhooks()).toEqual({ delivered: 0, failed: 0 });
    expect(h.claims).toEqual([]);
    expect(safeOutboundFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(h.rows.get('a'))).toBe(before);
  });

  it('reports idle pool errors & drains cleanup before rejecting', async () => {
    const error = new Error('idle connection lost'); h.poolError = error;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(deliverWebhooks()).rejects.toThrow('Webhook delivery pass failed');
    expect(logged).toHaveBeenCalledWith('[pg webhook pool error]', error);
    expect(h.endCalls).toBe(1);
  });
});
