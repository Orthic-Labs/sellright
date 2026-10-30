/**
 * Perf plan P0 (#360 "Measurement before optimization"): in-process metrics for the API.
 *
 *   - HTTP: one histogram per bounded (method, route template, status class) series — request duration (monotonic),
 *     per-request pool acquisition wait, plus in-flight requests and optional proxy queue time.
 *   - Pools: every pg pool the serving process owns is attached by name (instrumentPool): live gauges
 *     (total/idle/active/waiting/max), acquisition latency and client hold histograms, and always-on counters for
 *     acquisition timeouts, other acquisition errors and cancelled (discarded) clients.
 *   - Node: event-loop delay percentiles and utilization over the last sampling window, RSS and heap.
 *
 * Labels are bounded by construction: route TEMPLATES only (lib/request-id.ts loggedPath), a closed method set,
 * status classes, pool names chosen in code, and a hard series cap per family with an `<other>` overflow series.
 * Nothing here records parameters, query text, tokens or tenant data.
 *
 * Importing this module starts nothing (sdk/import-purity.test.ts): the event-loop sampler starts in createApp
 * (startRuntimeSampler) and stops at shutdown. Rendering is for the private endpoint in app.ts (METRICS_ACCESS).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';

// ── histograms ──────────────────────────────────────────────────────────────

/** Seconds. Covers sub-ms pool hits up to the 30 s statement ceiling. */
export const LATENCY_BUCKETS_S = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const;
/** Upper bound on distinct label sets per family; further sets fold into one `<other>` series. */
export const MAX_SERIES_PER_FAMILY = 400;
export const OVERFLOW_LABEL = '<other>';

export class Histogram {
  readonly counts: number[];
  sum = 0;
  count = 0;
  constructor(readonly buckets: readonly number[] = LATENCY_BUCKETS_S) { this.counts = new Array(buckets.length).fill(0); }
  observe(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.sum += seconds;
    this.count++;
    for (let i = 0; i < this.buckets.length; i++) if (seconds <= this.buckets[i]!) this.counts[i]!++;
  }
}

type Labels = Readonly<Record<string, string>>;

/** A histogram family keyed by label set, capped at MAX_SERIES_PER_FAMILY series. */
export class HistogramFamily {
  readonly series = new Map<string, { labels: Labels; h: Histogram }>();
  constructor(readonly name: string, readonly help: string, readonly labelNames: readonly string[], private readonly cap = MAX_SERIES_PER_FAMILY) {}
  observe(labels: Labels, seconds: number): void { this.get(labels).observe(seconds); }
  get(labels: Labels): Histogram {
    const key = this.labelNames.map((n) => labels[n] ?? '').join('\u0000');
    const existing = this.series.get(key);
    if (existing) return existing.h;
    // At the cap every new label set shares ONE overflow series (the cap + 1st), so memory stays bounded.
    const [k, l] = this.series.size < this.cap ? [key, labels]
      : [this.labelNames.map(() => OVERFLOW_LABEL).join('\u0000'), Object.fromEntries(this.labelNames.map((n) => [n, OVERFLOW_LABEL]))];
    let s = this.series.get(k);
    if (!s) { s = { labels: l, h: new Histogram() }; this.series.set(k, s); }
    return s.h;
  }
}

// ── HTTP requests ───────────────────────────────────────────────────────────

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const statusClass = (status: number) => (status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : 'other');

const httpDuration = new HistogramFamily('sellright_http_request_duration_seconds', 'HTTP request duration (monotonic), by route template', ['method', 'route', 'status_class']);
const httpDbWait = new HistogramFamily('sellright_http_request_db_acquire_seconds', 'Total time one request waited for pooled DB connections', ['method', 'route']);
let httpQueue = new Histogram();
let inFlight = 0;

/** Per-request tally the pool wrappers add to (pool acquisitions made while serving this request). */
export interface RequestStats { dbAcquires: number; dbAcquireMs: number }
const requestScope = new AsyncLocalStorage<RequestStats>();

/** Run `fn` (the rest of the middleware chain) with a fresh per-request tally; counts it as in flight meanwhile. */
export async function runInRequestScope<T>(stats: RequestStats, fn: () => Promise<T>): Promise<T> {
  inFlight++;
  try { return await requestScope.run(stats, fn); } finally { inFlight--; }
}

export function observeRequest(o: { method: string; route: string; status: number; durationMs: number; dbAcquireMs: number; queueMs?: number }): void {
  const method = METHODS.has(o.method) ? o.method : 'OTHER';
  httpDuration.observe({ method, route: o.route, status_class: statusClass(o.status) }, o.durationMs / 1000);
  httpDbWait.observe({ method, route: o.route }, o.dbAcquireMs / 1000);
  if (o.queueMs !== undefined) httpQueue.observe(o.queueMs / 1000);
}

/**
 * Proxy queue time from a request-start header the reverse proxy sets (nginx `X-Request-Start: t=${msec}`): seconds
 * with a fractional part, or `t=` followed by integer ms/µs. Undefined when absent, unparsable, in the future
 * or older than a minute (a clock skew or spoofed value never pollutes the histogram).
 */
export function queueMsFromHeader(value: string | undefined, nowMs: number = Date.now()): number | undefined {
  const m = value ? /^(?:t=)?(\d+(?:\.\d+)?)$/.exec(value.trim()) : null;
  if (!m) return undefined;
  const n = Number(m[1]);
  // Normalise to ms: seconds (nginx $msec, ~1.7e9), ms (~1.7e12) or µs (~1.7e15).
  const startMs = n < 1e11 ? n * 1000 : n < 1e14 ? n : n / 1000;
  const q = nowMs - startMs;
  return q >= 0 && q <= 60_000 ? q : undefined;
}

// ── pools ───────────────────────────────────────────────────────────────────

/** No pooled connection in time: pg-pool's acquire timeout, a connect that timed out, or the server's own
 *  too_many_connections (53300). db/client.ts isPoolTimeout() delegates here. */
export function isPoolTimeoutError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof Error && (e.message.includes('timeout exceeded when trying to connect')
      || e.message.includes('Connection terminated due to connection timeout'))) return true;
    if ((e as { code?: unknown }).code === '53300') return true;
  }
  return false;
}

interface PoolStats { acquire: Histogram; hold: Histogram; timeouts: number; acquireErrors: number; cancelled: number; attached: Set<Pool> }
const poolStats = new Map<string, PoolStats>();
const instrumented = new WeakSet<Pool>();

function statsFor(name: string): PoolStats {
  let s = poolStats.get(name);
  if (!s) {
    s = { acquire: new Histogram(), hold: new Histogram(), timeouts: 0, acquireErrors: 0, cancelled: 0, attached: new Set() };
    poolStats.set(name, s);
  }
  return s;
}

/**
 * Attach `pool` to the metrics under `name`. Counters and histograms are per NAME and survive the pool (a per-pass
 * pool such as the webhook delivery pool attaches each new instance under the same name); live gauges sum the
 * currently attached instances. Returns a detach function — call it when the pool is ended.
 *
 * Acquisition latency wraps `pool.connect` (pool.query() goes through it too); hold duration runs from the pool's
 * `acquire` event to its `release` event. A client released with an error (query_timeout, a transaction deadline,
 * a broken connection) is counted as cancelled: its in-flight work was abandoned and the connection discarded.
 */
export function instrumentPool(name: string, pool: Pool): () => void {
  const s = statsFor(name);
  s.attached.add(pool);
  if (!instrumented.has(pool)) {
    instrumented.add(pool);
    const acquiredAt = new WeakMap<PoolClient, number>();
    pool.on('acquire', (client) => { acquiredAt.set(client, performance.now()); });
    pool.on('release', (err, client) => {
      const t = acquiredAt.get(client);
      if (t !== undefined) { s.hold.observe((performance.now() - t) / 1000); acquiredAt.delete(client); }
      if (err) s.cancelled++;
    });
    const original = pool.connect.bind(pool) as (cb?: (err: Error | undefined, client?: PoolClient, done?: (e?: unknown) => void) => void) => unknown;
    const settle = (err: unknown, started: number) => {
      const ms = performance.now() - started;
      s.acquire.observe(ms / 1000);
      const r = requestScope.getStore();
      if (r) { r.dbAcquires++; r.dbAcquireMs += ms; }
      if (err) { if (isPoolTimeoutError(err)) s.timeouts++; else s.acquireErrors++; }
    };
    (pool as unknown as { connect: unknown }).connect = (cb?: (err: Error | undefined, client?: PoolClient, done?: (e?: unknown) => void) => void) => {
      const started = performance.now();
      if (typeof cb === 'function') {
        return original((err, client, done) => { settle(err, started); cb(err, client, done); });
      }
      return (original() as Promise<PoolClient>).then(
        (client) => { settle(undefined, started); return client; },
        (err: unknown) => { settle(err, started); throw err; },
      );
    };
  }
  return () => { s.attached.delete(pool); };
}

export interface PoolSnapshot {
  max: number; total: number; idle: number; active: number; waiting: number;
  acquireTimeouts: number; acquireErrors: number; cancelled: number;
  acquireMs: { count: number; avg: number }; holdMs: { count: number; avg: number };
}

export function poolSnapshots(): Record<string, PoolSnapshot> {
  const out: Record<string, PoolSnapshot> = {};
  for (const [name, s] of poolStats) {
    let max = 0, total = 0, idle = 0, waiting = 0;
    for (const p of s.attached) { max += p.options.max ?? 0; total += p.totalCount; idle += p.idleCount; waiting += p.waitingCount; }
    const avg = (h: Histogram) => ({ count: h.count, avg: h.count ? Math.round((h.sum / h.count) * 1e6) / 1e3 : 0 });
    out[name] = { max, total, idle, active: total - idle, waiting, acquireTimeouts: s.timeouts, acquireErrors: s.acquireErrors, cancelled: s.cancelled, acquireMs: avg(s.acquire), holdMs: avg(s.hold) };
  }
  return out;
}

// ── event loop / process ────────────────────────────────────────────────────

export const RUNTIME_SAMPLE_MS = 10_000;
type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;
interface Runtime { delay: IntervalHistogram; elu: EventLoopUtilization; timer: NodeJS.Timeout }
let runtime: Runtime | undefined;
let lastWindow = { p50: 0, p90: 0, p99: 0, max: 0, utilization: 0 };

function sampleWindow(r: Runtime): void {
  const now = performance.eventLoopUtilization();
  const delta = performance.eventLoopUtilization(now, r.elu);
  r.elu = now;
  const ms = (ns: number) => (Number.isFinite(ns) ? ns / 1e6 : 0);
  lastWindow = {
    p50: ms(r.delay.percentile(50)), p90: ms(r.delay.percentile(90)), p99: ms(r.delay.percentile(99)),
    max: ms(r.delay.max), utilization: delta.utilization,
  };
  r.delay.reset();
}

/** Start the event-loop sampler (createApp). Idempotent; its timer never keeps the process alive. */
export function startRuntimeSampler(windowMs: number = RUNTIME_SAMPLE_MS): void {
  if (runtime) return;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const r: Runtime = { delay, elu: performance.eventLoopUtilization(), timer: setInterval(() => sampleWindow(r), windowMs) };
  r.timer.unref();
  runtime = r;
}

/** Stop the sampler (shutdown). Idempotent. */
export function stopRuntimeSampler(): void {
  if (!runtime) return;
  clearInterval(runtime.timer);
  runtime.delay.disable();
  runtime = undefined;
}

export interface RuntimeSnapshot {
  eventLoopDelayMs: { p50: number; p90: number; p99: number; max: number };
  eventLoopUtilization: number; rssBytes: number; heapUsedBytes: number; inFlightRequests: number; sampling: boolean;
}

export function runtimeSnapshot(): RuntimeSnapshot {
  const mem = process.memoryUsage();
  const { utilization, ...delay } = lastWindow;
  return { eventLoopDelayMs: delay, eventLoopUtilization: utilization, rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, inFlightRequests: inFlight, sampling: runtime !== undefined };
}

// ── rendering ───────────────────────────────────────────────────────────────

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const fmtLabels = (l: Record<string, string>) => {
  const parts = Object.entries(l).map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};

function renderHistogram(lines: string[], name: string, labels: Record<string, string>, h: Histogram): void {
  h.buckets.forEach((b, i) => lines.push(`${name}_bucket${fmtLabels({ ...labels, le: String(b) })} ${h.counts[i]}`));
  lines.push(`${name}_bucket${fmtLabels({ ...labels, le: '+Inf' })} ${h.count}`);
  lines.push(`${name}_sum${fmtLabels(labels)} ${h.sum}`);
  lines.push(`${name}_count${fmtLabels(labels)} ${h.count}`);
}

/** Prometheus text exposition (version 0.0.4). `extraGauges` lets the caller add e.g. job admission gauges. */
export function renderPrometheus(extraGauges: Record<string, { help: string; value: number }> = {}): string {
  const lines: string[] = [];
  const head = (name: string, type: string, help: string) => { lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`); };
  for (const fam of [httpDuration, httpDbWait]) {
    head(fam.name, 'histogram', fam.help);
    for (const { labels, h } of fam.series.values()) renderHistogram(lines, fam.name, labels, h);
  }
  head('sellright_http_request_queue_seconds', 'histogram', 'Proxy-to-API queue time from the trusted request-start header');
  renderHistogram(lines, 'sellright_http_request_queue_seconds', {}, httpQueue);
  head('sellright_http_requests_in_flight', 'gauge', 'Requests currently being served');
  lines.push(`sellright_http_requests_in_flight ${inFlight}`);

  const pools = poolSnapshots();
  head('sellright_db_pool_connections', 'gauge', 'Pool connections by state (max is the configured ceiling)');
  for (const [pool, p] of Object.entries(pools)) {
    for (const state of ['max', 'total', 'idle', 'active', 'waiting'] as const) lines.push(`sellright_db_pool_connections${fmtLabels({ pool, state })} ${p[state]}`);
  }
  for (const [metric, key, help] of [
    ['sellright_db_pool_acquire_timeouts_total', 'timeouts', 'Connection acquisitions that timed out'],
    ['sellright_db_pool_acquire_errors_total', 'acquireErrors', 'Connection acquisitions that failed for another reason'],
    ['sellright_db_pool_cancelled_total', 'cancelled', 'Clients released with an error (work cancelled, connection discarded)'],
  ] as const) {
    head(metric, 'counter', help);
    for (const [pool, s] of poolStats) lines.push(`${metric}${fmtLabels({ pool })} ${s[key]}`);
  }
  head('sellright_db_pool_acquire_seconds', 'histogram', 'Time to obtain a pooled connection');
  for (const [pool, s] of poolStats) renderHistogram(lines, 'sellright_db_pool_acquire_seconds', { pool }, s.acquire);
  head('sellright_db_pool_hold_seconds', 'histogram', 'Time a pooled connection was held before release');
  for (const [pool, s] of poolStats) renderHistogram(lines, 'sellright_db_pool_hold_seconds', { pool }, s.hold);

  const rt = runtimeSnapshot();
  head('sellright_nodejs_eventloop_delay_seconds', 'gauge', 'Event-loop delay over the last sampling window');
  for (const [q, v] of [['0.5', rt.eventLoopDelayMs.p50], ['0.9', rt.eventLoopDelayMs.p90], ['0.99', rt.eventLoopDelayMs.p99], ['1', rt.eventLoopDelayMs.max]] as const) {
    lines.push(`sellright_nodejs_eventloop_delay_seconds${fmtLabels({ quantile: q })} ${v / 1000}`);
  }
  head('sellright_nodejs_eventloop_utilization', 'gauge', 'Event-loop utilization (0-1) over the last sampling window');
  lines.push(`sellright_nodejs_eventloop_utilization ${rt.eventLoopUtilization}`);
  head('sellright_process_resident_memory_bytes', 'gauge', 'Resident set size');
  lines.push(`sellright_process_resident_memory_bytes ${rt.rssBytes}`);
  head('sellright_nodejs_heap_used_bytes', 'gauge', 'V8 heap used');
  lines.push(`sellright_nodejs_heap_used_bytes ${rt.heapUsedBytes}`);
  for (const [name, g] of Object.entries(extraGauges)) { head(name, 'gauge', g.help); lines.push(`${name} ${g.value}`); }
  return `${lines.join('\n')}\n`;
}

/** Test-only: forget every series, counter and attached pool. */
export function _resetMetricsForTest(): void {
  httpDuration.series.clear();
  httpDbWait.series.clear();
  httpQueue = new Histogram();
  poolStats.clear();
  inFlight = 0;
  stopRuntimeSampler();
  lastWindow = { p50: 0, p90: 0, p99: 0, max: 0, utilization: 0 };
}
