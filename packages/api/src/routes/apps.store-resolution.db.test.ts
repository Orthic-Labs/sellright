/**
 * DB test for SEC-2: the licensing/download/update routes in apps.ts used to
 * resolve their store via a local `store()` helper that fell back straight to
 * DEV_DEFAULT_STORE ('damned') whenever x-store-slug was absent — bypassing
 * the production host-routing guard (OPS-1 / resolveStoreForRequest) that
 * every other store-scoped surface goes through. In production, a CDN
 * stripping the x-store-slug header (or a request to an unconfigured host)
 * would silently route every activation/update/download call into the
 * 'damned' store's license namespace instead of 404ing.
 *
 * Mirrors store-context.db.test.ts (same seed shape, same TRUNCATE discipline)
 * but drives the real route through createApp() end-to-end, and flips
 * env.NODE_ENV directly (a plain mutable object, not frozen — see env.ts)
 * rather than vi.mock'ing the module, matching the injectable-isProduction
 * rationale documented in store-context.db.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreCache } from '../store-context.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
// This suite needs a real Postgres — the shared *_test database, never a dev
// or prod one (it TRUNCATEs). Not wired into package.json's `test`/`test:db`
// split (out of scope for this change), so it self-gates: skip cleanly when
// DATABASE_URL isn't pointed at a _test database instead of throwing and
// failing the whole run. Run explicitly with DATABASE_URL=…/sellright_test.
const isTestDb = /_test(\b|$|\?)/.test(DB);

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeee0b00b000';
const SLUG = 'apps-store-resolution-test-store';
const DEFAULT_STORE_ID = 'eeeeeeee-eeee-eeee-eeee-eeee0b00b001';
const DEFAULT_SLUG = 'damned'; // matches DEV_DEFAULT_STORE

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed() {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({ hostnames: ['apps-store-resolution.example'] })}::jsonb)
      ON CONFLICT (id) DO NOTHING`);
  });
  // Seed the DEV_DEFAULT_STORE row so the pre-fix behavior (silently serving
  // 'damned') is actually reachable, and the non-production-fallback
  // assertion below has a real row to resolve.
  await withStore(DEFAULT_STORE_ID, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${DEFAULT_STORE_ID}, ${DEFAULT_SLUG}, ${DEFAULT_SLUG}, 'USD', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`);
  });
}

beforeEach(async () => {
  if (!isTestDb) return;
  invalidateStoreCache();
  await wipe();
  await seed();
});

afterEach(() => {
  env.NODE_ENV = 'test';
});

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!isTestDb)('GET /v1/apps/{appKey}/updates/latest — store resolution (SEC-2)', () => {
  it('404s in production when x-store-slug is absent and Host matches no store (never silently serves DEV_DEFAULT_STORE)', async () => {
    env.NODE_ENV = 'production';
    const app = createApp();
    const res = await app.request('/v1/apps/some-app/updates/latest', {
      headers: { host: 'unregistered.example', authorization: 'Bearer whatever-license-key' },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no store configured|missing host/i);
  });

  it('still resolves the real store by Host in production when it is configured (regression: not over-blocked)', async () => {
    env.NODE_ENV = 'production';
    const app = createApp();
    const res = await app.request('/v1/apps/some-app/updates/latest', {
      headers: { host: 'apps-store-resolution.example', authorization: 'Bearer whatever-license-key' },
    });
    // Store resolves fine; the 401 comes from the (deliberately garbage)
    // license key, proving we got past store resolution into the route body
    // rather than 404ing on the store.
    expect(res.status).toBe(401);
  });

  it('an explicit x-store-slug still resolves normally in production (bypasses host routing, as documented)', async () => {
    env.NODE_ENV = 'production';
    const app = createApp();
    const res = await app.request('/v1/apps/some-app/updates/latest', {
      headers: { 'x-store-slug': SLUG, authorization: 'Bearer whatever-license-key' },
    });
    expect(res.status).toBe(401); // past store resolution, into the license check
  });

  it('outside production, an unmatched host still falls back to DEV_DEFAULT_STORE (dev/CI keep working)', async () => {
    env.NODE_ENV = 'test';
    const app = createApp();
    const res = await app.request('/v1/apps/some-app/updates/latest', {
      headers: { host: 'unregistered.example', authorization: 'Bearer whatever-license-key' },
    });
    expect(res.status).toBe(401); // resolved to 'damned', then failed on the license key — not a 404
  });
});
