import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { metricsAccess } from './app.js';

// Perf plan P0: GET /v1/internal/metrics is private. METRICS_ACCESS=off hides it; loopback admits only a direct
// loopback peer that carried no forwarding header; admin needs an admin credential.
describe('metricsAccess', () => {
  const build = (mode: 'off' | 'loopback' | 'admin') => {
    const app = new Hono();
    app.get('/v1/internal/metrics', metricsAccess(() => mode), (c) => c.text('sellright_x 1'));
    return app;
  };
  const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

  it('off (default): 404 even from loopback', async () => {
    expect((await build('off').request('/v1/internal/metrics', {}, peer('127.0.0.1'))).status).toBe(404);
  });

  it('loopback: a direct loopback peer is served (IPv4, IPv6, mapped)', async () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const res = await build('loopback').request('/v1/internal/metrics', {}, peer(a));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('sellright_x 1');
    }
  });

  it('loopback: a proxied request (any forwarding header) or a non-loopback peer gets 404', async () => {
    const app = build('loopback');
    for (const h of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip']) {
      expect((await app.request('/v1/internal/metrics', { headers: { [h]: '203.0.113.9' } }, peer('127.0.0.1'))).status).toBe(404);
    }
    expect((await app.request('/v1/internal/metrics', {}, peer('172.22.0.1'))).status).toBe(404); // nginx on the Docker bridge
    expect((await app.request('/v1/internal/metrics')).status).toBe(404); // no socket information at all
  });

  it('admin: anonymous callers get 401 and no metrics', async () => {
    const res = await build('admin').request('/v1/internal/metrics', {}, peer('127.0.0.1'));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('sellright_x');
  });
});
