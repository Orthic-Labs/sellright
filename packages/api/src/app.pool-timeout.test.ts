import { describe, expect, it, vi } from 'vitest';

// #358 / #360: a request that cannot get a pooled connection in time answers 503 + Retry-After, not 500.
vi.mock('./env.js', () => ({ env: { DEBUG_ERRORS: '0' } }));
vi.setConfig({ testTimeout: 60000 });

describe('pool connect timeout', () => {
  it('maps to 503 SERVICE_BUSY with Retry-After, including when wrapped as a cause', async () => {
    const { createApp } = await import('./app.js');
    const app = createApp();
    app.get('/__fixture/pool-timeout', () => { throw new Error('timeout exceeded when trying to connect'); });
    app.get('/__fixture/wrapped', () => { throw new Error('Failed query: select 1', { cause: new Error('timeout exceeded when trying to connect') }); });
    app.get('/__fixture/other', () => { throw new Error('boom'); });
    for (const path of ['/__fixture/pool-timeout', '/__fixture/wrapped']) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('2');
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SERVICE_BUSY');
    }
    expect((await app.request('/__fixture/other')).status).toBe(500);
  });
});
