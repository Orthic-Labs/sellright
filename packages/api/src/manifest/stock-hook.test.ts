/**
 * Unit tests for the zero-cache stock hook (manifest/stock-hook.ts).
 *
 * Every dependency that would touch Postgres or the filesystem is mocked —
 * this suite is about the SIGNALING contract (when does a regeneration fire,
 * exactly how many run for N concurrent triggers, does a failure wedge future
 * triggers), not about what publishCatalogManifest itself writes (that's
 * manifest/catalog.db.test.ts and manifest/publish.test.ts). Runs in the
 * `unit` lane — no database required.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above every other top-level statement in this
// file, including plain `const`/`let` declarations — referencing one directly
// from a factory body throws a TDZ error. vi.hoisted's own callback runs
// first, before any vi.mock factory, so it's the only safe place to build
// state a factory needs to read synchronously (not just close over lazily).
const { envMock, publishSpy, logInfo, errError, markPending, clearPending, leader } = vi.hoisted(() => ({
  envMock: {
    CATALOG_MANIFEST_JOBS_ENABLED: '1',
    CATALOG_DIR: '/tmp/stock-hook-test' as string | undefined,
    STORE_SLUG: 'demo-store' as string | undefined,
  },
  publishSpy: vi.fn(async (_args: { outDir: string; storeSlug: string; variantIds?: string[] }) => ({ generation: 'g', products: 1 })),
  markPending: vi.fn(async () => ({ token: 'exact-db-token', requiresFull: false })),
  clearPending: vi.fn(async () => {}),
  leader: vi.fn(async (_job: string, fn: () => unknown) => fn()),
  logInfo: vi.fn(),
  errError: vi.fn(),
}));

vi.mock('../env.js', () => ({ env: envMock }));
vi.mock('./catalog.js', () => ({ CatalogPurgeError: class CatalogPurgeError extends Error { constructor(readonly published: { generation: string }) { super('purge failed'); } }, publishCatalogManifest: (args: { outDir: string; storeSlug: string; variantIds?: string[] }) => publishSpy(args) }));
const purgeHook = vi.hoisted(() => ({ onCatalogCacheChanged: vi.fn() }));
vi.mock('../cache/purge-hook.js', () => purgeHook);
// Single-process unit test: the real advisory lock is exercised by the DB
// suites (release-stale-allocations.test.ts, auto-deliver.test.ts). Here it's
// a pass-through so the in-process generating/trailing coalescing is what's
// under test, isolated from Postgres.
vi.mock('../jobs/leader-lock.js', () => ({ withLeaderLock: (...args: Parameters<typeof leader>) => leader(...args) }));
vi.mock('../lib/logger.js', () => ({ log: { info: (...a: unknown[]) => logInfo(...a) }, err: { error: (...a: unknown[]) => errError(...a) } }));
// SELLRIGHT-ISSUES P1 (durable retry): run() resolves the store id for the
// pending-marker bookkeeping and writes/clears it via manifest-pending.js —
// both would otherwise hit a real Postgres pool in this DB-free unit suite.
vi.mock('../store-context.js', () => ({ resolveStore: async (slug: string) => ({ id: `store-id-${slug}`, slug, name: slug, currency: 'USD', taxRate: 0, taxInclusive: false, shippingTaxable: false, config: null }) }));
vi.mock('./manifest-pending.js', () => ({ markManifestRegenerationPending: markPending, clearManifestRegenerationPending: clearPending }));

import { onCatalogContentChanged, onStockChanged, _resetStockHookStateForTest } from './stock-hook.js';

async function flush(times = 5) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  _resetStockHookStateForTest();
  markPending.mockReset();
  markPending.mockImplementation(async () => ({ token: 'exact-db-token', requiresFull: false }));
  clearPending.mockClear();
  leader.mockReset();
  leader.mockImplementation(async (_job: string, fn: () => unknown) => fn());
  publishSpy.mockClear();
  publishSpy.mockImplementation(async () => ({ generation: 'g', products: 1 }));
  logInfo.mockClear();
  errError.mockClear();
  envMock.CATALOG_MANIFEST_JOBS_ENABLED = '1';
  envMock.CATALOG_DIR = '/tmp/stock-hook-test';
  envMock.STORE_SLUG = 'demo-store';
});

describe('onStockChanged — zero-cache manifest signal', () => {
  it('acknowledges only its own exact durable token after a successful publish', async () => {
    onStockChanged('demo-store');
    await vi.waitFor(() => expect(clearPending).toHaveBeenCalledWith('store-id-demo-store', 'exact-db-token'));
  });

  it('retains durable retry when the leader lock skips publication', async () => {
    leader.mockImplementationOnce(async () => undefined);
    onStockChanged('demo-store');
    await vi.waitFor(() => expect(leader).toHaveBeenCalledTimes(1));
    await flush();
    expect(publishSpy).not.toHaveBeenCalled();
    expect(clearPending).not.toHaveBeenCalled();
  });

  it('marks triggers arriving during an in-flight publish before the trailing run', async () => {
    let release!: (value: { generation: string; products: number }) => void;
    publishSpy.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    onStockChanged('demo-store', ['v1']);
    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1));
    onStockChanged('demo-store', ['v2']);
    await vi.waitFor(() => expect(markPending).toHaveBeenCalledTimes(2));
    expect(publishSpy).toHaveBeenCalledTimes(1);
    release({ generation: 'first', products: 1 });
    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(2));
  });

  it('fully publishes an existing durable obligation before acknowledging its new token', async () => {
    // Another process marked product A, but lost the leader lock. Our product B
    // trigger sees that outstanding marker and must cover A as well as B.
    markPending.mockResolvedValueOnce({ token: 'new-token', requiresFull: true });
    onStockChanged('demo-store', ['product-b-variant']);
    await vi.waitFor(() => expect(clearPending).toHaveBeenCalledWith('store-id-demo-store', 'new-token'));
    expect(publishSpy.mock.calls[0]![0].variantIds).toBeUndefined();
  });

  it('no-ops when manifest publishing is not enabled', async () => {
    envMock.CATALOG_MANIFEST_JOBS_ENABLED = '0';
    onStockChanged('demo-store');
    await flush();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('no-ops when CATALOG_DIR/STORE_SLUG are not configured', async () => {
    envMock.CATALOG_DIR = undefined;
    onStockChanged('demo-store');
    await flush();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('no-ops for a store this deployment does not publish (single-store-per-process)', async () => {
    onStockChanged('some-other-store');
    await flush();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('regenerates immediately for the configured store — no debounce/delay', async () => {
    onStockChanged('demo-store');
    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1));
    expect(publishSpy).toHaveBeenCalledWith({ outDir: '/tmp/stock-hook-test', storeSlug: 'demo-store' });
  });

  it('collapses any number of concurrent triggers into at most one trailing rerun (never zero, never one-per-trigger)', async () => {
    let calls = 0;
    const resolvers: Array<(v: { generation: string; products: number }) => void> = [];
    publishSpy.mockImplementation(
      () => new Promise((resolve) => {
        calls++;
        resolvers.push(resolve);
      }),
    );

    // Five stock changes land while nothing has run yet.
    onStockChanged('demo-store');
    onStockChanged('demo-store');
    onStockChanged('demo-store');
    onStockChanged('demo-store');
    onStockChanged('demo-store');
    await flush();

    // Only the FIRST trigger started a generation synchronously; the other
    // four collapsed into a single trailing flag, not four queued runs.
    expect(calls).toBe(1);

    resolvers[0]!({ generation: 'g1', products: 1 });
    await vi.waitFor(() => expect(calls).toBe(2)); // the one trailing rerun starts

    resolvers[1]!({ generation: 'g2', products: 1 });
    await flush();
    // No further trigger arrived during run #2 — it must NOT start a third.
    expect(calls).toBe(2);
  });

  it('logs and swallows a publish failure — a broken generation must not throw into the caller or wedge future triggers', async () => {
    publishSpy.mockRejectedValueOnce(new Error('disk full'));
    expect(() => onStockChanged('demo-store')).not.toThrow();
    await vi.waitFor(() => expect(errError).toHaveBeenCalledTimes(1));

    onStockChanged('demo-store');
    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(2));
  });

  // SELLRIGHT-ISSUES P1: per-product regeneration scoping.
  describe('variantIds scoping', () => {
    it('passes variantIds through when the trigger names specific variants', async () => {
      onStockChanged('demo-store', ['v1', 'v2']);
      await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1));
      expect(publishSpy).toHaveBeenCalledWith({ outDir: '/tmp/stock-hook-test', storeSlug: 'demo-store', variantIds: ['v1', 'v2'] });
    });

    it('omitting variantIds means a full regen (variantIds undefined)', async () => {
      onStockChanged('demo-store');
      await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1));
      const call = publishSpy.mock.calls[0]![0];
      expect(call.variantIds).toBeUndefined();
    });

    it('merges variant sets across trailing triggers collapsed during one run', async () => {
      let calls = 0;
      const resolvers: Array<(v: { generation: string; products: number }) => void> = [];
      publishSpy.mockImplementation(
        () => new Promise((resolve) => { calls++; resolvers.push(resolve); }),
      );
      onStockChanged('demo-store', ['v1']);
      onStockChanged('demo-store', ['v2']);
      onStockChanged('demo-store', ['v1']); // duplicate — must not appear twice
      await flush();
      expect(calls).toBe(1);
      resolvers[0]!({ generation: 'g1', products: 1 });
      await vi.waitFor(() => expect(calls).toBe(2));
      const secondCall = publishSpy.mock.calls[1]![0];
      expect(new Set(secondCall.variantIds)).toEqual(new Set(['v1', 'v2']));
    });

    it('ANY untagged trigger forces the whole collapsed batch to a full regen', async () => {
      let calls = 0;
      const resolvers: Array<(v: { generation: string; products: number }) => void> = [];
      publishSpy.mockImplementation(
        () => new Promise((resolve) => { calls++; resolvers.push(resolve); }),
      );
      onStockChanged('demo-store', ['v1']);
      onStockChanged('demo-store'); // untagged — poisons the batch to full
      onStockChanged('demo-store', ['v2']);
      await flush();
      expect(calls).toBe(1);
      resolvers[0]!({ generation: 'g1', products: 1 });
      await vi.waitFor(() => expect(calls).toBe(2));
      const secondCall = publishSpy.mock.calls[1]![0];
      expect(secondCall.variantIds).toBeUndefined(); // full regen, not a partial variant list
    });
  });
});

// Storefront plan A9 scenario 10 — the burst oracle. Not "one generation per change": the first trigger starts a
// generation immediately with no timer of any kind, and any burst during an in-flight generation collapses into exactly
// one trailing generation whose merged scope covers every trigger. Observation only: nothing in stock-hook.ts changes.
describe('burst oracle (plan A9 scenario 10)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('(a) the first trigger publishes immediately and arms no timer', async () => {
    vi.useFakeTimers();
    onStockChanged('demo-store', ['v1']);
    expect(vi.getTimerCount(), 'onStockChanged must not arm a debounce/TTL timer').toBe(0);
    await flush(30); // microtasks only: no timer is advanced
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('(b) K triggers during one in-flight generation produce exactly one trailing generation covering all K variants', async () => {
    const K = 12;
    let calls = 0;
    const resolvers: Array<(v: { generation: string; products: number }) => void> = [];
    publishSpy.mockImplementation(() => new Promise((resolve) => { calls++; resolvers.push(resolve); }));

    onStockChanged('demo-store', ['v0']);
    await flush(30);
    expect(calls).toBe(1); // in flight, held open by the test's deferred promise
    const ids = Array.from({ length: K }, (_, i) => `burst-${i}`);
    for (const id of ids) onStockChanged('demo-store', [id]);
    await flush(30);
    expect(calls, 'triggers during a run must not start their own generations').toBe(1);

    resolvers[0]!({ generation: 'g1', products: 1 });
    await vi.waitFor(() => expect(calls).toBe(2));
    const trailing = publishSpy.mock.calls[1]![0];
    expect(new Set(trailing.variantIds)).toEqual(new Set(ids));

    resolvers[1]!({ generation: 'g2', products: 1 });
    await flush(30);
    expect(calls, 'no third generation: nothing arrived during the trailing run').toBe(2);
  });

  it('(d) static guard: stock-hook.ts contains no setTimeout/setInterval CALL (comments excluded)', () => {
    const source = readFileSync(new URL('./stock-hook.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/\b(setTimeout|setInterval|setImmediate)\s*\(/);
    expect(code).not.toMatch(/\bdebounce|\bthrottle/i);
  });
});

describe('V60 / N9 — content triggers and purge ordering', () => {
  beforeEach(() => purgeHook.onCatalogCacheChanged.mockClear());

  it('a product edit schedules a product-scoped publication, and does not purge ahead of it', async () => {
    onCatalogContentChanged('demo-store', ['prod-1'], { productPath: '/products/a/' });
    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1));
    expect(publishSpy.mock.calls[0]![0]).toEqual({ outDir: '/tmp/stock-hook-test', storeSlug: 'demo-store', productIds: ['prod-1'] });
    expect(purgeHook.onCatalogCacheChanged).not.toHaveBeenCalled();
  });

  it('a stock trigger no longer purges before its publication', async () => {
    onStockChanged('demo-store', ['v1']);
    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1));
    expect(purgeHook.onCatalogCacheChanged).not.toHaveBeenCalled();
  });

  it('purges at once where this deployment publishes no catalog', () => {
    onCatalogContentChanged('other-store', ['prod-1'], { productPath: '/products/a/' });
    expect(purgeHook.onCatalogCacheChanged).toHaveBeenCalledWith('other-store', { productPath: '/products/a/' });
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('keeps the durable marker when publication succeeded but the purge failed', async () => {
    const { CatalogPurgeError } = await import('./catalog.js');
    publishSpy.mockImplementationOnce(async () => { throw new CatalogPurgeError({ generation: 'g', products: 1 }); });
    onCatalogContentChanged('demo-store', ['prod-1']);
    await vi.waitFor(() => expect(errError).toHaveBeenCalled());
    await flush();
    expect(clearPending).not.toHaveBeenCalled();
  });
});
