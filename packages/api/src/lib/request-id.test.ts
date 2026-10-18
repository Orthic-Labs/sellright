import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * OBS-1: request-id middleware contract.
 *
 *   - inbound `x-request-id` is trusted when it looks safe (alnum + .-_)
 *   - otherwise a uuid v4 is minted
 *   - the resolved id is attached to c.var.requestId
 *   - the same id is echoed on the response's `x-request-id` header
 *   - the access log line carries it
 *
 * We mount only the middleware under test on a fresh Hono app so a route's
 * downstream handler doesn't depend on the full app wiring (database, csrf,
 * host routing, etc.).
 */
describe('request-id middleware', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let captured: string[];

  beforeEach(async () => {
    captured = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | string[]) => {
      captured.push(Array.isArray(chunk) ? chunk.join('') : chunk);
      return true;
    }) as typeof process.stdout.write);
    // Ensure a clean module graph — the middleware reads c.var types from
    // Hono and we don't want a previous test's side effects.
    vi.resetModules();
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('echoes a safe inbound x-request-id on the response and exposes it on c.var', async () => {
    const { requestIdMiddleware } = await import('./request-id.js');
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.get('/probe', (c) => c.json({ requestId: c.var.requestId }));

    const res = await app.request('/probe', { headers: { 'x-request-id': 'trace-abc.123' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('trace-abc.123');
    const body = await res.json() as { requestId: string };
    expect(body.requestId).toBe('trace-abc.123');
  });

  it('mints a uuid v4 when no inbound header is present', async () => {
    const { requestIdMiddleware } = await import('./request-id.js');
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.get('/probe', (c) => c.json({ requestId: c.var.requestId }));

    const res = await app.request('/probe');
    const body = await res.json() as { requestId: string };
    // uuid v4 has the 8-4-4-4-12 shape with version nibble 4 and variant nibble in {8,9,a,b}.
    expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
  });

  it('echoes the resolved id after a raw Response replaces prepared headers', async () => {
    const { requestIdMiddleware } = await import('./request-id.js');
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.get('/raw', (c) => new Response(c.var.requestId, { status: 202, headers: {
      'Content-Type': 'text/plain', 'X-Endpoint': 'raw-response', 'X-Request-Id': 'route-value',
    } }));

    const res = await app.request('/raw', { headers: { 'x-request-id': 'raw-response-id' } });
    expect(res.status).toBe(202);
    expect(res.headers.get('x-request-id')).toBe('raw-response-id');
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('x-endpoint')).toBe('raw-response');
    expect(await res.text()).toBe('raw-response-id');
  });

  it('echoes an id on immutable redirects while preserving status, location and empty body', async () => {
    const { requestIdMiddleware } = await import('./request-id.js');
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.get('/redirect', () => Response.redirect('https://redirect.example/destination?keep=1', 307));

    const res = await app.request('/redirect', { headers: { 'x-request-id': 'immutable-response-id' } });
    expect(res.status).toBe(307);
    expect(res.headers.get('x-request-id')).toBe('immutable-response-id');
    expect(res.headers.get('location')).toBe('https://redirect.example/destination?keep=1');
    expect(await res.text()).toBe('');
  });

  it('rejects a hostile inbound header (script tag, control chars, oversize) and mints a fresh id', async () => {
    const { requestIdMiddleware } = await import('./request-id.js');
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.get('/probe', (c) => c.json({ requestId: c.var.requestId }));

    const hostile = '<script>alert(1)</script>';
    const res = await app.request('/probe', { headers: { 'x-request-id': hostile } });
    const body = await res.json() as { requestId: string };
    expect(body.requestId).not.toBe(hostile);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i);

    const oversize = 'a'.repeat(201);
    const res2 = await app.request('/probe', { headers: { 'x-request-id': oversize } });
    const body2 = await res2.json() as { requestId: string };
    expect(body2.requestId).not.toBe(oversize);
  });

  it('emits a JSON access log line per request carrying requestId + method + path + status + durationMs', async () => {
    const { requestIdMiddleware, accessLogMiddleware } = await import('./request-id.js');
    const app = new Hono();
    // Access log depends on c.var.requestId being set — mount request-id first.
    app.use('*', requestIdMiddleware());
    app.use('*', accessLogMiddleware());
    app.get('/probe', (c) => c.json({ ok: true }));

    await app.request('/probe', { headers: { 'x-request-id': 'req-access-1' } });

    const lines = captured.join('').split('\n').filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));
    const access = parsed.find((p) => p.msg === 'request' && p.requestId === 'req-access-1');
    expect(access).toBeTruthy();
    expect(access.method).toBe('GET');
    expect(access.path).toBe('/probe');
    expect(access.status).toBe(200);
    expect(typeof access.durationMs).toBe('number');
    expect(access.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs the matched route TEMPLATE, with a fixed sentinel for unmatched paths', async () => {
    const { requestIdMiddleware, accessLogMiddleware } = await import('./request-id.js');
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.use('*', accessLogMiddleware());
    app.get('/v1/shop/subscriber/confirm/:token', (c) => c.json({ ok: true }));
    const secret = 'Zx9secretTOKENvalue1234567890abcdef';
    await app.request(`/v1/shop/subscriber/confirm/${secret}`, { headers: { 'x-request-id': 'req-tpl-1' } });
    await app.request(`/v1/nowhere/${encodeURIComponent('tok/en%' + secret)}`, { headers: { 'x-request-id': 'req-tpl-2' } });
    await app.request('/v1/nowhere/%5A%78%39abc', { headers: { 'x-request-id': 'req-tpl-3' } });
    const all = captured.join('');
    expect(all).not.toContain(secret);
    expect(all).not.toContain('Zx9abc');
    const parsed = all.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(parsed.find((p) => p.requestId === 'req-tpl-1')!.path).toBe('/v1/shop/subscriber/confirm/:token');
    expect(parsed.find((p) => p.requestId === 'req-tpl-2')!.path).toBe('<unmatched>');
    expect(parsed.find((p) => p.requestId === 'req-tpl-3')!.path).toBe('<unmatched>');
  });

  it.each([
    { label: 'short alphabetic segment', path: '/v1/nowhere/alpha' },
    { label: '24-letter segment', path: '/v1/nowhere/abcdefghijklmnopqrstuvwx' },
    { label: 'percent-encoded segment', path: '/v1/nowhere/%61%6c%70%68%61' },
    { label: 'nested percent-encoding', path: '/v1/nowhere/%2561%256c%2570%2568%2561' },
  ])('logs no unmatched path content for $label while preserving request metrics', async ({ path }) => {
    const { requestIdMiddleware, accessLogMiddleware } = await import('./request-id.js');
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.use('*', accessLogMiddleware());
    app.get('/probe', (c) => c.json({ ok: true }));

    const res = await app.request(path, { headers: { 'x-request-id': 'req-unmatched' } });

    expect(res.status).toBe(404);
    expect(res.headers.get('x-request-id')).toBe('req-unmatched');
    const access = captured.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .find((line) => line.msg === 'request' && line.requestId === 'req-unmatched');
    expect(access).toMatchObject({ requestId: 'req-unmatched', method: 'GET', path: '<unmatched>', status: 404 });
    expect(typeof access.durationMs).toBe('number');
    expect(access.durationMs).toBeGreaterThanOrEqual(0);
  });
});
