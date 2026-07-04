/**
 * PERF-2: cache unit tests for resolveStore / resolveStoreByHost.
 *
 * Pure unit — the underlying `pool` is vi.mock'd so the cache layer is exercised
 * without a real Postgres connection. The DB test for the rest of the file's
 * functions lives in store-context.db.test.ts (excluded from `pnpm test`).
 *
 * Covers the contract the lane spec calls out:
 *   - HIT   → same StoreCtx object, no second pool.query call.
 *   - MISS  → expired entry is dropped on read and the next call re-queries.
 *   - INV   → explicit invalidateStoreCache forces the next call to re-query.
 *   - Host  → cache by host works (resolveStoreByHost).
 *   - Cap   → opportunistic eviction when the map grows past MAX_ENTRIES.
 *
 * No DB, no module reset needed — we mock the pool surface the production code
 * actually depends on (`pool.query`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the production store-context module sees the stubbed `pool`.
// Each test sets `queryImpl` for the duration of the test and restores in afterEach.
let queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
vi.mock('./db/client.js', () => ({
  get pool() {
    return { query: (sql: string, params?: unknown[]) => queryImpl(sql, params) };
  },
  withStore: <T>(_storeId: string, fn: (tx: unknown) => Promise<T>) => fn({}),
}));

import {
  _cacheSizeForTest,
  invalidateStoreCache,
  resolveStore,
  resolveStoreByHost,
  type StoreCtx,
} from './store-context.js';

const STORE_A: StoreCtx = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  slug: 'alpha',
  name: 'Alpha',
  currency: 'USD',
  taxRate: 0,
  taxInclusive: false,
  shippingTaxable: false,
  config: { hostnames: ['alpha.example'] },
};
const STORE_B: StoreCtx = { ...STORE_A, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', slug: 'beta', config: { hostnames: ['beta.example'] } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-04T12:00:00Z'));
  queryImpl = vi.fn(async () => ({ rows: [STORE_A] }));
  invalidateStoreCache(); // start every test with an empty cache
});

afterEach(() => {
  invalidateStoreCache();
  vi.useRealTimers();
});

describe('resolveStore cache (PERF-2)', () => {
  it('first call hits the DB, subsequent calls hit memory without re-querying', async () => {
    const spy = vi.fn(async (_sql: string, params?: unknown[]) => ({ rows: [STORE_A] }));
    queryImpl = spy;

    const first = await resolveStore('alpha');
    const second = await resolveStore('alpha');
    const third = await resolveStore('alpha');

    expect(first).toBe(second); // same object — not just equal
    expect(second).toBe(third);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toEqual(['alpha']);
  });

  it('after TTL expires (60s) the cache evicts and the next call re-queries', async () => {
    const spy = vi.fn(async () => ({ rows: [STORE_A] }));
    queryImpl = spy;

    await resolveStore('alpha');
    expect(spy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(59_000); // just before TTL
    await resolveStore('alpha');
    expect(spy).toHaveBeenCalledTimes(1); // still cached

    vi.advanceTimersByTime(2_000); // now past TTL
    await resolveStore('alpha');
    expect(spy).toHaveBeenCalledTimes(2); // re-queried
  });

  it('explicit invalidateStoreCache(slug) forces a fresh DB read on the next call', async () => {
    let n = 0;
    queryImpl = vi.fn(async () => ({ rows: n++ === 0 ? [STORE_A] : [{ ...STORE_A, name: 'Alpha v2' }] }));

    const first = await resolveStore('alpha');
    expect(first.name).toBe('Alpha');
    expect(queryImpl).toHaveBeenCalledTimes(1);

    invalidateStoreCache('alpha');

    const second = await resolveStore('alpha');
    expect(second.name).toBe('Alpha v2'); // proves we re-fetched, not served stale
    expect(queryImpl).toHaveBeenCalledTimes(2);
  });

  it('invalidateStoreCache() with no args flushes every slug and host entry', async () => {
    queryImpl = vi.fn(async () => ({ rows: [STORE_A, STORE_B] }));
    await resolveStore('alpha');
    await resolveStore('beta');
    await resolveStoreByHost('alpha.example');
    expect(_cacheSizeForTest()).toEqual({ slug: 2, host: 1 });

    invalidateStoreCache();
    expect(_cacheSizeForTest()).toEqual({ slug: 0, host: 0 });
  });

  it('invalidateStoreCache(slug) also drops host entries cached against that slug', async () => {
    queryImpl = vi.fn(async () => ({ rows: [STORE_A] }));
    await resolveStore('alpha'); // seeds slug cache
    await resolveStoreByHost('alpha.example'); // seeds host cache with STORE_A
    expect(_cacheSizeForTest()).toEqual({ slug: 1, host: 1 });

    invalidateStoreCache('alpha');
    expect(_cacheSizeForTest()).toEqual({ slug: 0, host: 0 }); // both dropped
  });

  it('invalidateStoreCache(undefined, host) drops only that host entry', async () => {
    queryImpl = vi.fn(async () => ({ rows: [STORE_A, STORE_B] }));
    await resolveStore('alpha');
    await resolveStoreByHost('alpha.example');
    expect(_cacheSizeForTest()).toEqual({ slug: 1, host: 1 });

    invalidateStoreCache(undefined, 'alpha.example');
    expect(_cacheSizeForTest()).toEqual({ slug: 1, host: 0 });
  });

  it('a fresh slug hits the DB independently of other slug cache entries', async () => {
    const spy = vi.fn(async (sql: string, params?: unknown[]) => {
      const slug = params?.[0] as string;
      return { rows: slug === 'alpha' ? [STORE_A] : [STORE_B] };
    });
    queryImpl = spy;

    const a = await resolveStore('alpha');
    const b = await resolveStore('beta');
    const a2 = await resolveStore('alpha');

    expect(a2).toBe(a); // alpha served from cache
    expect(b.id).toBe(STORE_B.id);
    expect(spy).toHaveBeenCalledTimes(2); // one per unique slug
  });
});

describe('resolveStoreByHost cache (PERF-2)', () => {
  it('first call hits the DB, subsequent calls hit memory without re-querying', async () => {
    const spy = vi.fn(async () => ({ rows: [STORE_A] }));
    queryImpl = spy;

    const first = await resolveStoreByHost('alpha.example');
    const second = await resolveStoreByHost('alpha.example');

    expect(first).toBe(second);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a negative lookup (no store declares the host) is NOT cached — next call re-queries', async () => {
    const spy = vi.fn(async () => ({ rows: [STORE_A] })); // hostnames don't include 'unknown.example'
    queryImpl = spy;

    expect(await resolveStoreByHost('unknown.example')).toBeNull();
    expect(await resolveStoreByHost('unknown.example')).toBeNull();
    // Negative misses must re-query so a hostname-add edit takes effect before TTL.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('after TTL expires the host cache evicts and the next call re-queries', async () => {
    const spy = vi.fn(async () => ({ rows: [STORE_A] }));
    queryImpl = spy;

    await resolveStoreByHost('alpha.example');
    vi.advanceTimersByTime(61_000);
    await resolveStoreByHost('alpha.example');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('explicit invalidateStoreCache(undefined, host) forces a fresh DB read on the next call', async () => {
    queryImpl = vi.fn(async () => ({ rows: [STORE_A] }));
    await resolveStoreByHost('alpha.example');
    expect(queryImpl).toHaveBeenCalledTimes(1);

    invalidateStoreCache(undefined, 'alpha.example');
    await resolveStoreByHost('alpha.example');
    expect(queryImpl).toHaveBeenCalledTimes(2);
  });
});

describe('cache cap (opportunistic eviction on write over MAX_ENTRIES)', () => {
  it('drops the oldest entries once a map exceeds MAX_ENTRIES so size stays bounded', async () => {
    // Override the cap by importing the module-level constant via a fresh path:
    // we exercise the cap semantics here indirectly by stuffing >1000 entries and
    // checking the map back-pressures. The cap guard is in writeCache; the
    // observable contract is "size never exceeds MAX_ENTRIES by more than one
    // insert" — that is what we assert.
    queryImpl = vi.fn(async (_sql: string, params?: unknown[]) => ({
      rows: [{ ...STORE_A, slug: (params?.[0] as string) ?? 'alpha' }],
    }));

    // Stuff 1100 distinct slugs. Without the cap guard, size would be 1100.
    for (let i = 0; i < 1100; i++) {
      const slug = `s-${i.toString().padStart(4, '0')}`;
      await resolveStore(slug);
    }
    const { slug: size } = _cacheSizeForTest();
    expect(size).toBeLessThanOrEqual(1000);
    expect(size).toBeGreaterThan(900); // close to the cap, not zero
  });
});
