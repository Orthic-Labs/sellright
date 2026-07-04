/**
 * DB test for OPS-1 CORS wiring (vs sellright_test ONLY — TRUNCATEs).
 * Mirrors subscriptions.test.ts / store-context.db.test.ts: _test-DB guard +
 * TRUNCATE store CASCADE wipe + seed under withStore(). Drives the real Hono
 * app (createApp()) through a CORS preflight OPTIONS request — the pure
 * matching logic is covered separately in cors-origins.test.ts; this file
 * proves the middleware is actually mounted and reads store.config.hostnames
 * end-to-end.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from './app.js';
import { pool, withStore } from './db/client.js';
import { env } from './env.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`app cors db test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const SLUG = 'ops1-cors-test-store';
const ALLOWED_ORIGIN = 'https://shop.cors-test.example';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed() {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({ hostnames: ['shop.cors-test.example'] })}::jsonb)
      ON CONFLICT (id) DO NOTHING`);
  });
}

beforeEach(async () => {
  await wipe();
  await seed();
});

afterAll(async () => {
  await pool.end();
});

describe('CORS (OPS-1)', () => {
  it('a preflight from an allowlisted origin (matches store.config.hostnames) succeeds', async () => {
    const app = createApp();
    const res = await app.request('/v1/health', {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('a preflight from a non-allowlisted origin is rejected (no CORS headers granted)', async () => {
    const app = createApp();
    const res = await app.request('/v1/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://attacker.example',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never grants wildcard-with-credentials for an allowlisted origin', async () => {
    const app = createApp();
    const res = await app.request('/v1/health', {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'GET',
      },
    });

    // credentials:true requires an echoed exact origin, never '*'.
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('a same-origin request with no Origin header is unaffected by the CORS middleware', async () => {
    const app = createApp();
    const res = await app.request('/v1/health');
    expect(res.status).toBe(200);
  });
});
