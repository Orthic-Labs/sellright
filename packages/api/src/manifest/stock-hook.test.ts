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
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above every other top-level statement in this
// file, including plain `const`/`let` declarations — referencing one directly
// from a factory body throws a TDZ error. vi.hoisted's own callback runs
// first, before any vi.mock factory, so it's the only safe place to build
// state a factory needs to read synchronously (not just close over lazily).
const { envMock, publishSpy, logInfo, errError } = vi.hoisted(() => ({
  envMock: {
    CATALOG_MANIFEST_JOBS_ENABLED: '1',
    CATALOG_DIR: '/tmp/stock-hook-test' as string | undefined,
    STORE_SLUG: 'demo-store' as string | undefined,
  },
  publishSpy: vi.fn(async (_args: { outDir: string; storeSlug: string }) => ({ generation: 'g', products: 1 })),
  logInfo: vi.fn(),
  errError: vi.fn(),
}));

vi.mock('../env.js', () => ({ env: envMock }));
vi.mock('./catalog.js', () => ({ publishCatalogManifest: (args: { outDir: string; storeSlug: string }) => publishSpy(args) }));
// Single-process unit test: the real advisory lock is exercised by the DB
// suites (release-stale-allocations.test.ts, auto-deliver.test.ts). Here it's
// a pass-through so the in-process generating/trailing coalescing is what's
// under test, isolated from Postgres.
vi.mock('../jobs/leader-lock.js', () => ({ withLeaderLock: (_job: string, fn: () => unknown) => fn() }));
vi.mock('../lib/logger.js', () => ({ log: { info: (...a: unknown[]) => logInfo(...a) }, err: { error: (...a: unknown[]) => errError(...a) } }));

import { onStockChanged, _resetStockHookStateForTest } from './stock-hook.js';

async function flush(times = 5) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  _resetStockHookStateForTest();
  publishSpy.mockClear();
  publishSpy.mockImplementation(async () => ({ generation: 'g', products: 1 }));
  logInfo.mockClear();
  errError.mockClear();
  envMock.CATALOG_MANIFEST_JOBS_ENABLED = '1';
  envMock.CATALOG_DIR = '/tmp/stock-hook-test';
  envMock.STORE_SLUG = 'demo-store';
});

describe('onStockChanged — zero-cache manifest signal', () => {
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
});
