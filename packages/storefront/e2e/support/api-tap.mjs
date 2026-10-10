// Recording reverse proxy between the storefront (server-side fetches AND the browser-side /v1 proxy in fixtures.ts)
// and the real API. Started by playwright.config.ts when E2E_API_TAP=1.
//
// Every proxied request is appended to E2E_RUN_DIR/api-requests.jsonl as one line, written when the response ends:
//   { startedAt, endedAt, method, path, status, origin }
//   path    pathname + search as the API sees it
//   origin  'browser' when the request carried `x-e2e-origin: browser` (set by fixtures.ts), else 'server'
//           (the storefront's own SSR / route-loader fetches, including JSON-LD)
// The log is observation only: the tap never caches, retries, rewrites a response or reorders requests.
// GET /__tap/health and GET /__tap/inflight are answered locally and are not logged.
import http from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { API_LOG_FILE, API_URL, TAP_PORT } from './env.mjs';

const target = new URL(process.env.E2E_TAP_TARGET ?? API_URL);
mkdirSync(dirname(API_LOG_FILE), { recursive: true });
writeFileSync(API_LOG_FILE, ''); // each run starts with an empty log

let inflight = 0;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const server = http.createServer((req, res) => {
  if (req.url === '/__tap/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (req.url === '/__tap/inflight') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ inflight })); }

  const startedAt = Date.now();
  const origin = req.headers['x-e2e-origin'] === 'browser' ? 'browser' : 'server';
  inflight++;
  let logged = false;
  const log = (status) => {
    if (logged) return;
    logged = true;
    inflight--;
    appendFileSync(API_LOG_FILE, JSON.stringify({ startedAt, endedAt: Date.now(), method: req.method, path: req.url, status, origin }) + '\n');
  };

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || k === 'x-e2e-origin') continue;
    headers[k] = v;
  }
  headers.host = target.host;
  const upstream = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (ures) => {
    const out = {};
    for (const [k, v] of Object.entries(ures.headers)) if (!HOP.has(k)) out[k] = v;
    res.writeHead(ures.statusCode ?? 502, out);
    ures.pipe(res);
    ures.on('end', () => log(ures.statusCode ?? 502));
    ures.on('error', () => log(502));
  });
  upstream.on('error', (err) => {
    log(502);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'TAP_UPSTREAM_FAILED', message: String(err) } }));
  });
  res.on('close', () => log(res.statusCode || 499)); // client went away before the upstream answered
  req.pipe(upstream);
});

server.listen(TAP_PORT, '127.0.0.1', () => console.log(`[e2e] api tap :${TAP_PORT} -> ${target.origin}, log ${API_LOG_FILE}`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
