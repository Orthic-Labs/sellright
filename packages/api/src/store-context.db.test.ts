/**
 * DB tests for OPS-1 host->store routing (vs sellright_test ONLY — TRUNCATEs).
 * Mirrors subscriptions.test.ts: _test-DB guard + TRUNCATE store CASCADE wipe
 * + seed under withStore(). vitest runs files serially (fileParallelism: false).
 *
 * resolveStoreForRequest takes an injectable `isProduction` param (defaults to
 * env.NODE_ENV === 'production') specifically so these tests can exercise both
 * branches directly, without vi.mock'ing env.js — that would require
 * vi.resetModules() before every re-import, which would also re-instantiate
 * db/client.ts's module-scope `pg.Pool` and leak connections across tests.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from './db/client.js';
import { env } from './env.js';
import {
  HostRoutingError, invalidateStoreCache, resolveStoreByHost, resolveStoreForRequest,
  broadcastStoreCacheInvalidation, startStoreCacheInvalidationListener,
  _stopStoreCacheInvalidationListenerForTest, _cacheSizeForTest,
} from './store-context.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`store-context db test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SLUG = 'ops1-host-test-store';
const HOST = 'damned.example';

const DEFAULT_STORE_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeef';
const DEFAULT_SLUG = 'damned'; // matches DEV_DEFAULT_STORE — seeded so tests
// exercising the explicit x-store-slug=damned path and the non-production
// fallback path have a real row to resolve, without relying on any ambient
// baseline seed existing in sellright_test.

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed() {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({ hostnames: [HOST] })}::jsonb)
      ON CONFLICT (id) DO NOTHING`);
  });
  await withStore(DEFAULT_STORE_ID, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${DEFAULT_STORE_ID}, ${DEFAULT_SLUG}, ${DEFAULT_SLUG}, 'USD', ${JSON.stringify({ hostnames: ['damned-default.example'] })}::jsonb)
      ON CONFLICT (id) DO NOTHING`);
  });
}

beforeEach(async () => {
  // PERF-2: process-wide cache flush — TRUNCATE wipes the rows that the
  // in-proc slug/host cache would otherwise keep alive for 60s.
  invalidateStoreCache();
  await wipe();
  await seed();
});

afterAll(async () => {
  await pool.end();
});

describe('resolveStoreByHost', () => {
  it('finds the store whose config.hostnames contains the exact host', async () => {
    const store = await resolveStoreByHost(HOST);
    expect(store?.slug).toBe(SLUG);
  });

  it('finds the store for a subdomain of a configured hostname', async () => {
    const store = await resolveStoreByHost(`checkout.${HOST}`);
    expect(store?.slug).toBe(SLUG);
  });

  it('returns null for a host no store has configured', async () => {
    const store = await resolveStoreByHost('unregistered.example');
    expect(store).toBeNull();
  });
});

describe('resolveStoreForRequest precedence (OPS-1)', () => {
  it('an explicit x-store-slug header wins even when Host also matches a different store', async () => {
    const st = await resolveStoreForRequest({ storeSlugHeader: 'damned', host: HOST }, false);
    expect(st.slug).toBe('damned'); // the seeded DEV_DEFAULT_STORE, not our test store
  });

  it('resolves by Host when no x-store-slug header is present', async () => {
    const st = await resolveStoreForRequest({ host: HOST }, false);
    expect(st.slug).toBe(SLUG);
  });

  it('prefers X-Forwarded-Host over Host when both are present', async () => {
    const st = await resolveStoreForRequest({ host: 'unregistered.example', forwardedHost: HOST }, false);
    expect(st.slug).toBe(SLUG);
  });

  it('falls back to DEV_DEFAULT_STORE outside production when the host matches nothing', async () => {
    const st = await resolveStoreForRequest({ host: 'unregistered.example' }, false);
    expect(st.slug).toBe('damned');
  });

  it('in production, an unmatched host 404s instead of silently serving the dev default', async () => {
    await expect(resolveStoreForRequest({ host: 'unregistered.example' }, true)).rejects.toThrow(HostRoutingError);
  });

  it('in production, a missing Host header also 404s rather than defaulting', async () => {
    await expect(resolveStoreForRequest({}, true)).rejects.toThrow(HostRoutingError);
  });

  it('in production, an explicit x-store-slug header still resolves normally (bypasses host routing)', async () => {
    const st = await resolveStoreForRequest({ storeSlugHeader: SLUG }, true);
    expect(st.slug).toBe(SLUG);
  });

  it('defaults isProduction from env.NODE_ENV when the param is omitted (sanity check, dev DB env)', async () => {
    // sellright_test runs with NODE_ENV=test (not 'production'), so the
    // default should behave like the non-production branch here.
    expect(env.NODE_ENV).not.toBe('production');
    const st = await resolveStoreForRequest({ host: 'unregistered.example' });
    expect(st.slug).toBe('damned');
  });
});

// SELLRIGHT-ISSUES P2: cross-process cache invalidation via Postgres LISTEN/
// NOTIFY (store-context.ts). Runs its own describe block (starts/stops the
// dedicated listener client) so it can't leak an open connection into the
// rest of this file's tests.
describe('cross-process store cache invalidation (LISTEN/NOTIFY)', () => {
  afterAll(async () => {
    await _stopStoreCacheInvalidationListenerForTest();
  });

  it('a NOTIFY from one connection reaches a listener started on a different connection', async () => {
    await startStoreCacheInvalidationListener();
    // Warm the cache via the normal path.
    await resolveStoreByHost(HOST);
    expect(_cacheSizeForTest().host).toBeGreaterThan(0);

    // Broadcast from a completely separate query (simulating another API
    // process's admin-settings.ts save) — NOT the same call that warmed the
    // cache above, and not going through the listener client at all.
    await broadcastStoreCacheInvalidation(undefined, HOST);

    // The listener is async (a Postgres notification callback) — give the
    // event loop a tick to deliver it before asserting.
    await new Promise((r) => setTimeout(r, 200));
    expect(_cacheSizeForTest().host).toBe(0);
  });

  it('invalidating by slug also drops any host cache entry for that slug', async () => {
    await startStoreCacheInvalidationListener();
    await resolveStoreByHost(HOST);
    expect(_cacheSizeForTest().host).toBeGreaterThan(0);
    await broadcastStoreCacheInvalidation(SLUG);
    await new Promise((r) => setTimeout(r, 200));
    expect(_cacheSizeForTest().host).toBe(0);
  });

  it('starting the listener twice is a no-op (idempotent)', async () => {
    await startStoreCacheInvalidationListener();
    await startStoreCacheInvalidationListener(); // must not throw / open a second client
    await resolveStoreByHost(HOST);
    await broadcastStoreCacheInvalidation(undefined, HOST);
    await new Promise((r) => setTimeout(r, 200));
    expect(_cacheSizeForTest().host).toBe(0);
  });
});
