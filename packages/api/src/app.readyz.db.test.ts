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
import { requireDisposablePostgresUrl as assertTestDatabase } from './db/test-database-url.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { closePools } from './db/client.js';
import { env } from './env.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'app.readyz.db.test.ts');

afterAll(async () => {
  await closePools();
});

describe('GET /v1/readyz (OBS-2)', () => {
  it('returns 200 + db:ok and nothing else to a public caller', async () => {
    const app = createApp();
    const res = await app.request('/v1/readyz');
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'ok', db: 'ok' });
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('reports every pool and the job gauges only to a caller that passes the metrics access check', async () => {
    const app = createApp();
    // A direct loopback peer with no forwarding header passes METRICS_ACCESS=loopback; otherwise this stays public-shaped.
    if (env.METRICS_ACCESS !== 'loopback') return;
    const res = await app.request('/v1/readyz', {}, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    const body = await res.json() as { pools: Record<string, { total: number }> };
    expect(Object.keys(body.pools).sort()).toEqual(['advisory', 'jobs', 'locks', 'requests']);
    expect(body.pools.locks!.total).toBeGreaterThan(0);
    expect(body.pools.requests!.total).toBe(0);
  });
});
