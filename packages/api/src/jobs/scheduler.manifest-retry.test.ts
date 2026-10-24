import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  publish: vi.fn(async () => ({ generation: 'published', products: 1 })),
  clear: vi.fn(async () => {}),
  load: vi.fn(async () => [{ storeId: 'store', storeSlug: 'fixture', requestedAt: new Date('2026-01-01'), token: 'exact-microsecond-token' }]),
  info: vi.fn(),
  publishAllowed: false,
}));
vi.mock('../env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../env.js')>();
  return { ...actual, env: { ...actual.env, JOBS_ENABLED: '1', NODE_ENV: 'development', CATALOG_MANIFEST_JOBS_ENABLED: '1', CATALOG_DIR: '/fixture', STORE_SLUG: 'fixture' } };
});
vi.mock('../maintenance.js', () => ({ isMaintenanceOn: () => false }));
vi.mock('../manifest/catalog.js', () => ({ publishCatalogManifest: mocks.publish }));
vi.mock('../manifest/manifest-pending.js', () => ({ loadStalePendingManifestRegenerations: mocks.load, clearManifestRegenerationPending: mocks.clear }));
vi.mock('../lib/logger.js', () => ({ log: { info: mocks.info, warn: vi.fn(), error: vi.fn() }, err: { error: vi.fn() } }));
vi.mock('./leader-lock.js', () => ({
  withLeaderLock: async (job: string, fn: () => unknown) => {
    if (job === 'catalog-manifest-drain' || (job === 'catalog-manifest' && mocks.publishAllowed)) return fn();
    return undefined; // every unrelated scheduled job skips before touching data
  },
}));
import { startJobScheduler, type JobScheduler } from './scheduler.js';
import { resetJobAdmission } from './admission.js';
let scheduler: JobScheduler | undefined;
afterEach(async () => {
  await scheduler?.stop();
  scheduler = undefined;
  resetJobAdmission(); // createApp does this at every start; a stopped admission stays stopped otherwise
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.publishAllowed = false;
});

describe('durable manifest drain', () => {
  it('retains pending work & emits no recovery log when the publisher leader lock is busy', async () => {
    vi.useFakeTimers();
    scheduler = startJobScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.load).toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.info.mock.calls.some(([message]) => String(message).includes('recovered a lost regeneration'))).toBe(false);
  });

  it('acknowledges the loaded exact token only after an actual publish', async () => {
    vi.useFakeTimers();
    mocks.publishAllowed = true;
    scheduler = startJobScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.publish).toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalledWith('store', 'exact-microsecond-token');
    expect(mocks.info.mock.calls.some(([message]) => String(message).includes('recovered a lost regeneration'))).toBe(true);
  });
});
