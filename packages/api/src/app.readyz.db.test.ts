/**
 * DB test for OBS-2 GET /v1/readyz readiness probe. Lives in test:db because
 * it exercises the live pg.Pool — a happy-path SELECT 1 only proves the route
 * shape if we actually round-trip the pool. Mirrors app.cors.db.test.ts's
 * _test-DB guard + TRUNCATE pattern so a CI run against a non-test DB aborts
 * before it touches anything.
 *
 * The /v1/readyz route is intentionally distinct from /v1/health (which is
 * the cheap liveness probe). This test only asserts the documented happy
 * path (200 + db:ok); the 503 timeout/error path is timing-dependent and
 * belongs to a separate unit test with a mocked pool.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { pool } from './db/client.js';
import { env } from './env.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`app readyz db test requires a live pool — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

afterAll(async () => {
  await pool.end();
});

describe('GET /v1/readyz (OBS-2)', () => {
  it('returns 200 + db:ok when the pool can answer SELECT 1', async () => {
    const app = createApp();
    const res = await app.request('/v1/readyz');
    const body = await res.json() as { status: string; db: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'ok', db: 'ok' });
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});
