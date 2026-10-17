import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { buildHttpApp } from './app.js';
import { matchesNumericRouteBodyLimit, resolveNumericRouteBodyLimits } from './numeric-route-body-limit.js';
import type { EngineContext, NumericRouteBodyLimit } from './sdk/index.js';

vi.mock('./cors-origins.js', () => ({ isAllowedCorsOrigin: async () => false, isAllowedAdminCorsOrigin: () => false }));
vi.mock('./maintenance.js', () => ({ isMaintenanceOn: () => false, maintenanceInfo: () => ({ maintenance: false }) }));

const CAP = 90 * 1024 * 1024;
const PREFIXES = ['/admin/multipart/part/', '/v1/artifact-proxy/example/admin/multipart/part/'];
const ctx = { env: {} } as EngineContext;
const policies: NumericRouteBodyLimit[] = PREFIXES.map((pathPrefix) => ({ method: 'PUT', pathPrefix, finalSegment: 'ascii-digits', maxBytes: CAP }));

function source(sizes: readonly number[]) {
  let index = 0;
  let pulls = 0;
  let canceled = false;
  const chunk = new Uint8Array(Math.max(...sizes, 0));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (index === sizes.length) controller.close();
      else controller.enqueue(chunk.subarray(0, sizes[index++]));
    },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  return { body, pulls: () => pulls, canceled: () => canceled };
}

function composition(bodyLimits: readonly NumericRouteBodyLimit[] = policies) {
  const routes = new OpenAPIHono();
  let storageCalls = 0;
  let consumed = 0;
  let seenSignal: AbortSignal | undefined;
  for (const prefix of PREFIXES) routes.all(`${prefix}*`, async (c) => {
    // Models both signed ingress and application-token checks, ahead of any body/storage access.
    if (c.req.header('authorization') !== 'Bearer test-upload') return c.json({ error: 'unauthorized' }, 401);
    if (c.req.header('x-mode') === 'ack-without-read') return c.json({ ok: true });
    storageCalls++;
    seenSignal = c.req.raw.signal;
    const reader = c.req.raw.body?.getReader();
    try {
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumed += value.byteLength;
        if (c.req.header('x-mode') === 'storage-failure') throw new Error('storage failed');
      }
      return c.json({ bytes: consumed });
    } catch {
      // Existing proxy/storage catch-all behavior must not swallow engine overflow or length failure.
      return c.json({ error: 'storage unavailable' }, c.req.header('x-mode') === 'catch-success' ? 200 : 503);
    } finally { reader?.releaseLock(); }
  });
  const app = buildHttpApp({ ctx, plugins: [{ name: 'stream-test', routes, bodyLimits }] });
  return { app, storageCalls: () => storageCalls, consumed: () => consumed, seenSignal: () => seenSignal };
}

function request(path: string, body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}, extra: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    method: 'PUT', body, headers: { Authorization: 'Bearer test-upload', ...headers }, duplex: 'half', ...extra,
  } as RequestInit);
}

describe('composed numeric-route streaming body caps', () => {
  it.each(PREFIXES)('streams an authorized 90 MiB part on %s without buffering', async (prefix) => {
    const { app, consumed, storageCalls, seenSignal } = composition();
    const input = source(Array(90).fill(1024 * 1024));
    const req = request(`${prefix}01?uploadId=fixture`, input.body, { 'Content-Length': String(CAP) });
    expect(input.pulls()).toBe(0);
    const response = await app.request(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: CAP });
    expect(consumed()).toBe(CAP);
    expect(storageCalls()).toBe(1);
    expect(input.pulls()).toBe(91);
    expect(input.canceled()).toBe(false);
    expect(seenSignal()?.aborted).toBe(false);
  });

  it('counts unknown lengths and verifies exact known lengths', async () => {
    const variants: Record<string, string>[] = [{}, { 'Content-Length': '3' }];
    for (const headers of variants) {
      const { app } = composition();
      const input = source([1, 2]);
      expect((await app.request(request(`${PREFIXES[0]}1`, input.body, headers))).status).toBe(200);
    }
  });

  it.each([undefined, String(CAP), '1'])('keeps actual overflow 413 through catch-all success/503, declared %s', async (declared) => {
    for (const mode of ['catch-success', 'normal']) {
      const { app, consumed } = composition();
      const input = source([CAP, 1, 1]);
      const response = await app.request(request(`${PREFIXES[0]}1`, input.body, {
        ...(declared === undefined ? {} : { 'Content-Length': declared }), 'x-mode': mode,
      }));
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
      expect(consumed()).toBe(CAP); // No over-limit chunk reached storage.
      expect(input.pulls()).toBe(2);
      expect(input.canceled()).toBe(true);
    }
  });

  it.each(['1, 2', '-1', '1.5', '1e3', 'NaN', '9007199254740992'])('rejects malformed Content-Length %s without reads/storage', async (length) => {
    const { app, storageCalls } = composition();
    const input = source([1]);
    const response = await app.request(request(`${PREFIXES[0]}1`, input.body, { 'Content-Length': length }));
    expect(response.status).toBe(400);
    expect(input.pulls()).toBe(0);
    expect(storageCalls()).toBe(0);
    expect(input.canceled()).toBe(true);
  });

  it('rejects declared overflow before reading, and under/overstated lengths after consumption', async () => {
    const { app, storageCalls } = composition();
    const large = source([1]);
    expect((await app.request(request(`${PREFIXES[0]}1`, large.body, { 'Content-Length': String(CAP + 1) }))).status).toBe(413);
    expect(large.pulls()).toBe(0);
    expect(storageCalls()).toBe(0);
    for (const length of ['1', '3']) {
      const fixture = composition();
      const input = source([2]);
      expect((await fixture.app.request(request(`${PREFIXES[0]}1`, input.body, { 'Content-Length': length, 'x-mode': 'catch-success' }))).status).toBe(400);
    }
  });

  it.each(PREFIXES)('rejects unauthorized %s requests without pulling or storing bytes', async (prefix) => {
    const { app, storageCalls } = composition();
    const input = source([1024, 1024]);
    const response = await app.request(request(`${prefix}1`, input.body, { Authorization: 'Bearer rejected' }));
    expect(response.status).toBe(401);
    expect(input.pulls()).toBe(0);
    expect(storageCalls()).toBe(0);
    expect(input.canceled()).toBe(true);
  });

  it('cancels remaining input on storage failure and rejects an unread successful acknowledgement', async () => {
    for (const [mode, expectedStatus, expectedPulls] of [['storage-failure', 503, 1], ['ack-without-read', 400, 0]] as const) {
      const { app } = composition();
      const input = source([1, 1, 1]);
      const response = await app.request(request(`${PREFIXES[0]}1`, input.body, { 'x-mode': mode }));
      expect(response.status).toBe(expectedStatus);
      expect(input.pulls()).toBe(expectedPulls);
      expect(input.canceled()).toBe(true);
    }
  });

  it('propagates client abort and cancels a pending upstream read', async () => {
    const { app, storageCalls, seenSignal } = composition();
    const aborter = new AbortController();
    let firstPull!: () => void;
    const pulled = new Promise<void>((resolve) => { firstPull = resolve; });
    let canceled = false;
    const input = new ReadableStream<Uint8Array>({
      pull() { firstPull(); return new Promise<void>(() => {}); },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 });
    const pending = app.request(request(`${PREFIXES[0]}1`, input, {}, { signal: aborter.signal }));
    await pulled;
    expect(storageCalls()).toBe(1);
    aborter.abort();
    const response = await pending;
    expect(response.status).toBe(400);
    expect(seenSignal()?.aborted).toBe(true);
    expect(canceled).toBe(true);
  });

  it('pulls source only when authenticated storage asks for another chunk', async () => {
    let releaseStorage!: () => void;
    const storageReady = new Promise<void>((resolve) => { releaseStorage = resolve; });
    let firstRead!: () => void;
    const readOnce = new Promise<void>((resolve) => { firstRead = resolve; });
    const input = source([1, 1, 1]);
    const routes = new OpenAPIHono().put(`${PREFIXES[0]}:part`, async (c) => {
      const reader = c.req.raw.body!.getReader();
      await reader.read();
      firstRead();
      await storageReady;
      while (!(await reader.read()).done) { /* Storage controls demand. */ }
      reader.releaseLock();
      return c.json({ ok: true });
    });
    const app = buildHttpApp({ ctx, plugins: [{ name: 'backpressure', bodyLimits: policies, routes }] });
    const pending = app.request(request(`${PREFIXES[0]}1`, input.body));
    await readOnce;
    expect(input.pulls()).toBe(1);
    releaseStorage();
    expect((await pending).status).toBe(200);
    expect(input.pulls()).toBe(4);
  });

  it('keeps default caps on wrong methods, nonnumeric/encoded segments, suffixes and neighbors', async () => {
    for (const [path, method] of [
      [`${PREFIXES[0]}1`, 'POST'], [`${PREFIXES[0]}one`, 'PUT'], [`${PREFIXES[0]}%31`, 'PUT'],
      [`${PREFIXES[0]}1/extra`, 'PUT'], [`${PREFIXES[0]}1.json`, 'PUT'], ['/admin/multipart/initiate', 'POST'],
    ]) {
      const { app, storageCalls } = composition();
      const input = source([1]);
      const response = await app.request(request(path!, input.body, { 'Content-Length': String(3 * 1024 * 1024) }, { method }));
      expect(response.status, `${method} ${path}`).toBe(413);
      expect(storageCalls()).toBe(0);
    }
  });

  it('preserves admin credential/CSRF and shop CSRF checks alongside stream policies', async () => {
    const { app } = composition();
    expect((await app.request('/v1/admin/assets', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/v1/admin/assets', { method: 'POST', headers: { Cookie: 'sr_admin=present' } })).status).toBe(403);
    expect((await app.request('/v1/shop/plugin-probe', { method: 'POST', headers: { Cookie: 'sr_cust=present' } })).status).toBe(403);
    const health = await app.request('/v1/health');
    expect(health.status).toBe(200);
  });

  it('validates/freeze policy data and rejects conflicts/protected or patterned paths', () => {
    const first = policies[0]!;
    expect(() => composition([first, first])).toThrow(/duplicate/);
    for (const pathPrefix of ['/v1/admin/assets/', '/v1/shop/upload/', '/v1/licenses/activate/', '/api/licenses/activate/', '/releases/part/', '/.well-known/part/', '/v1/', '/admin/:part/', '/admin/*/', '/admin/%31/', '/admin/../part/']) {
      expect(() => composition([{ ...first, pathPrefix }]), pathPrefix).toThrow();
    }
    for (const maxBytes of [0, -1, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => composition([{ ...first, maxBytes }])).toThrow();
    const input = [{ ...first }];
    const result = resolveNumericRouteBodyLimits([{ name: 'copies', bodyLimits: input }]);
    input[0]!.maxBytes = 1;
    expect(result[0]!.maxBytes).toBe(CAP);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    for (const suffix of ['', 'one', '%31', '1/2', '1.json', '1\n']) expect(matchesNumericRouteBodyLimit(first, 'PUT', `${first.pathPrefix}${suffix}`)).toBe(false);
  });
});
