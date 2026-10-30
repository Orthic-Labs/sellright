import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HistogramFamily, OVERFLOW_LABEL, _resetMetricsForTest, instrumentPool, isPoolTimeoutError, poolSnapshots,
  queueMsFromHeader, renderPrometheus, runInRequestScope, runtimeSnapshot, startRuntimeSampler, stopRuntimeSampler,
  type RequestStats,
} from './metrics.js';
import { accessLogMiddleware, requestIdMiddleware } from './request-id.js';

/** A pg-pool stand-in with the surface instrumentPool uses: connect (callback and promise forms, as pool.query and
 *  withStore call it), the acquire/release events, and the live counters. `next` decides the next acquisition. */
class FakePool extends EventEmitter {
  options = { max: 3 };
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  next: { err?: Error; delayMs?: number } = {};
  connect(cb?: (err: Error | undefined, client?: PoolClient, done?: () => void) => void): Promise<PoolClient> | void {
    const { err, delayMs = 0 } = this.next;
    const client = { release: (e?: unknown) => { this.emit('release', e, client); } } as unknown as PoolClient;
    const p = new Promise<PoolClient>((resolve, reject) => setTimeout(() => {
      if (err) return reject(err);
      this.emit('acquire', client);
      resolve(client);
    }, delayMs));
    if (!cb) return p;
    p.then((c) => cb(undefined, c, () => undefined), (e: Error) => cb(e));
  }
}
const asPool = (p: FakePool) => p as unknown as Pool;

afterEach(() => _resetMetricsForTest());

describe('HistogramFamily (bounded labels)', () => {
  it('folds every label set past the cap into one overflow series', () => {
    const fam = new HistogramFamily('t', 'test', ['route'], 3);
    for (let i = 0; i < 50; i++) fam.observe({ route: `/r/${i}` }, 0.01);
    expect(fam.series.size).toBe(4); // 3 real + 1 overflow, however many distinct routes arrive
    const overflow = [...fam.series.values()].find((s) => s.labels.route === OVERFLOW_LABEL)!;
    expect(overflow.h.count).toBe(47);
  });

  it('places observations in cumulative buckets and ignores invalid values', () => {
    const fam = new HistogramFamily('t', 'test', ['route']);
    const h = fam.get({ route: '/x' });
    h.observe(0.002); h.observe(0.3); h.observe(-1); h.observe(Number.NaN);
    expect(h.count).toBe(2);
    expect(h.counts[h.buckets.indexOf(0.005)]).toBe(1);
    expect(h.counts[h.buckets.indexOf(0.5)]).toBe(2);
  });
});

describe('queueMsFromHeader', () => {
  const now = 1_700_000_000_000;
  it('reads nginx $msec seconds, ms and µs forms', () => {
    expect(queueMsFromHeader('t=1699999999.750', now)).toBeCloseTo(250, 3);
    expect(queueMsFromHeader('1699999999900', now)).toBe(100);
    expect(queueMsFromHeader('t=1699999999950000', now)).toBe(50);
  });
  it('rejects absent, malformed, future and stale values', () => {
    expect(queueMsFromHeader(undefined, now)).toBeUndefined();
    expect(queueMsFromHeader('soon', now)).toBeUndefined();
    expect(queueMsFromHeader('t=1700000005.000', now)).toBeUndefined();
    expect(queueMsFromHeader('t=1699999000.000', now)).toBeUndefined(); // > 60 s old
  });
});

describe('instrumentPool', () => {
  it('records acquisition latency, hold time, timeouts and cancelled clients, and adds waits to the request tally', async () => {
    const fake = new FakePool();
    instrumentPool('requests', asPool(fake));
    const stats: RequestStats = { dbAcquires: 0, dbAcquireMs: 0 };
    await runInRequestScope(stats, async () => {
      fake.next = { delayMs: 20 };
      const c = await asPool(fake).connect();
      c.release();
      fake.next = {};
      await new Promise<void>((resolve) => asPool(fake).connect((err, c2) => { expect(err).toBeUndefined(); c2!.release(true as unknown as Error); resolve(); }));
    });
    expect(stats.dbAcquires).toBe(2);
    expect(stats.dbAcquireMs).toBeGreaterThanOrEqual(15);

    fake.next = { err: new Error('timeout exceeded when trying to connect') };
    await expect(asPool(fake).connect()).rejects.toThrow('timeout exceeded');
    fake.next = { err: new Error('ECONNREFUSED') };
    await expect(asPool(fake).connect()).rejects.toThrow('ECONNREFUSED');

    const s = poolSnapshots().requests!;
    expect(s).toMatchObject({ max: 3, acquireTimeouts: 1, acquireErrors: 1, cancelled: 1 });
    expect(s.acquireMs.count).toBe(4);
    expect(s.holdMs.count).toBe(2);
  });

  it('keeps per-name counters across pool instances; gauges cover only attached pools', async () => {
    const a = new FakePool();
    const detachA = instrumentPool('webhookPass', asPool(a));
    a.next = { err: new Error('timeout exceeded when trying to connect') };
    await expect(asPool(a).connect()).rejects.toThrow();
    detachA();
    const b = new FakePool();
    b.totalCount = 2; b.idleCount = 1; b.waitingCount = 4;
    instrumentPool('webhookPass', asPool(b));
    expect(poolSnapshots().webhookPass).toMatchObject({ max: 3, total: 2, idle: 1, active: 1, waiting: 4, acquireTimeouts: 1 });
  });

  it('classifies pool timeouts through the cause chain and 53300', () => {
    expect(isPoolTimeoutError(new Error('x', { cause: new Error('Connection terminated due to connection timeout') }))).toBe(true);
    expect(isPoolTimeoutError(Object.assign(new Error('too many'), { code: '53300' }))).toBe(true);
    expect(isPoolTimeoutError(new Error('syntax error'))).toBe(false);
  });
});

describe('request metrics via the access log middleware', () => {
  it('observes duration by route template and status class, never the raw path', async () => {
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.use('*', accessLogMiddleware());
    app.get('/v1/shop/subscriber/confirm/:token', (c) => c.json({ ok: true }));
    await app.request('/v1/shop/subscriber/confirm/secret-token-123');
    await app.request('/v1/nowhere/secret-token-456');
    const text = renderPrometheus();
    expect(text).toContain('sellright_http_request_duration_seconds_count{method="GET",route="/v1/shop/subscriber/confirm/:token",status_class="2xx"} 1');
    expect(text).toContain('route="<unmatched>",status_class="4xx"');
    expect(text).not.toContain('secret-token');
  });

  it('reads queue time only from the configured header', async () => {
    const app = new Hono();
    app.use('*', accessLogMiddleware({ requestStartHeader: () => 'x-request-start' }));
    app.get('/p', (c) => c.text('ok'));
    await app.request('/p', { headers: { 'x-request-start': `t=${(Date.now() - 40) / 1000}` } });
    expect(renderPrometheus()).toMatch(/sellright_http_request_queue_seconds_count 1\n/);
  });
});

describe('renderPrometheus', () => {
  it('exposes pool gauges and counters, event-loop gauges and caller gauges', async () => {
    const fake = new FakePool();
    fake.totalCount = 2; fake.idleCount = 2;
    instrumentPool('locks', asPool(fake));
    startRuntimeSampler(5);
    await new Promise((r) => setTimeout(r, 30));
    expect(runtimeSnapshot().sampling).toBe(true);
    const text = renderPrometheus({ sellright_jobs_active_passes: { help: 'h', value: 2 } });
    stopRuntimeSampler();
    expect(text).toContain('sellright_db_pool_connections{pool="locks",state="max"} 3');
    expect(text).toContain('sellright_db_pool_connections{pool="locks",state="active"} 0');
    expect(text).toContain('sellright_db_pool_acquire_timeouts_total{pool="locks"} 0');
    expect(text).toContain('sellright_nodejs_eventloop_delay_seconds{quantile="0.99"}');
    expect(text).toContain('sellright_nodejs_eventloop_utilization');
    expect(text).toContain('sellright_jobs_active_passes 2');
    for (const line of text.trim().split('\n')) expect(line).toMatch(/^(# (HELP|TYPE) \S+ .+|[a-z_]+(\{[^}]*\})? \S+)$/);
  });
});
