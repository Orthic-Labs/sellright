// Loaded into the e2e API process only (`node --import ./preload.mjs dist/index.js`, see start-api.mjs).
// It is the whole "gateway seam": no API source is touched, and nothing here exists in a normal run.
//
//  1. fetch: the sandbox gateway hosts (sandbox.nmi.com, sandbox.gateway.sezzle.com) and the IndexNow endpoint
//     (api.indexnow.org — a search engine must never be pinged from a test) are rewritten to the local mock
//     (E2E_MOCK_URL). Every other non-loopback fetch THROWS — a real gateway (secure.nmi.com, gateway.sezzle.com,
//     api.stripe.com …) can never be reached from this process, whatever mode a spec flips.
//  2. http.request: outbound webhooks go through safeOutboundFetch, which (correctly) refuses private addresses, so
//     the receiver cannot live on 127.0.0.1. The endpoint URL points at a public-looking sentinel address, and this
//     hook reroutes exactly that host:port to the mock's receiver. Anything else passes through untouched.
//  3. setInterval: the scheduler's 60s email / webhook / gateway-event passes run every E2E_JOB_INTERVAL_MS instead, so
//     specs observe "the outbox drained" in seconds rather than minutes.
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

if (process.env.NODE_ENV === 'production' && process.env.SR_E2E_PRELOAD !== '1') {
  throw new Error('e2e preload refused: set SR_E2E_PRELOAD=1 explicitly (it must never be loaded into a real deployment)');
}

const mock = new URL(process.env.E2E_MOCK_URL ?? 'http://127.0.0.1:3397');
const SANDBOX = { 'sandbox.nmi.com': '/nmi', 'sandbox.gateway.sezzle.com': '/sezzle', 'api.indexnow.org': '/indexnow' };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const realFetch = globalThis.fetch;
globalThis.fetch = function e2eFetch(input, init) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  const prefix = SANDBOX[url.hostname];
  if (prefix) {
    const target = mock.origin + prefix + url.pathname + url.search;
    return realFetch(typeof input === 'object' && !(input instanceof URL) && typeof input !== 'string' ? new Request(target, input) : target, init);
  }
  if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
  return Promise.reject(new Error(`[e2e] outbound fetch to ${url.hostname} blocked (only the sandbox gateway hosts are mocked)`));
};

const sentinelHost = process.env.E2E_HOOK_HOST ?? '45.45.45.45';
const sentinelPort = String(process.env.E2E_HOOK_PORT ?? '8045');
const realRequest = http.request;
http.request = function e2eRequest(...args) {
  const first = args[0];
  if (first instanceof URL && first.hostname === sentinelHost && first.port === sentinelPort) {
    const opts = typeof args[1] === 'object' && args[1] ? { ...args[1] } : {};
    const callback = args.find((a) => typeof a === 'function');
    delete opts.lookup;
    delete opts.servername;
    return realRequest({ ...opts, protocol: 'http:', host: mock.hostname, hostname: mock.hostname, port: mock.port, path: '/hook' + first.pathname.replace(/^\/hook/, '') + first.search }, callback);
  }
  return realRequest.apply(this, args);
};
syncBuiltinESMExports();

const interval = Number(process.env.E2E_JOB_INTERVAL_MS ?? 1000);
const realSetInterval = globalThis.setInterval;
const sped = new Set();
globalThis.setInterval = function e2eSetInterval(fn, ms, ...rest) {
  const timer = realSetInterval(fn, ms === 60_000 ? interval : ms, ...rest);
  if (ms === 60_000) sped.add(timer);
  return timer;
};
// A 1s scheduler must not keep ticking while the API is closing its pool on SIGTERM (it would only spam the log).
process.once('SIGTERM', () => { for (const t of sped) clearInterval(t); });
