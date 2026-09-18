import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { allowedDemoRequest, allowedDemoBody, demoBindHost } from './policy.mjs';
import { assertDemoData, cleanDemo, demoCounts } from './safety.mjs';
import { createHash } from 'node:crypto';

const database = new URL(process.env.DATABASE_URL ?? '');
if (database.pathname !== '/sellright_demo' || process.env.SELLRIGHT_DEMO !== '1') {
  throw new Error('Demo server requires SELLRIGHT_DEMO=1 and isolated sellright_demo database');
}
if (!process.env.DEMO_ADMIN_PASSWORD || process.env.SMTP_ENABLED !== 'false' ||
    process.env.JOBS_ENABLED !== '0') throw new Error('Demo requires a dedicated visitor password, SMTP disabled and jobs disabled');
for (const [key, value] of Object.entries(process.env)) {
  if (value && /^(STRIPE_.*KEY|STRIPE_.*SECRET|SMTP_HOST|GMAIL_USER|EMAIL_PASS|APNS_KEY_P8|SOURCE_DATABASE_URL)$/.test(key)) {
    throw new Error('Demo must not have external service credentials: ' + key);
  }
}
if (process.env.GATEWAY_ACCOUNTS_JSON_FILE ||
    (process.env.GATEWAY_ACCOUNTS_JSON && process.env.GATEWAY_ACCOUNTS_JSON !== '[]')) {
  throw new Error('Demo must not have gateway accounts');
}
const { createApp } = await import('../../packages/api/dist/app.js');
const { pool, assertRuntimeRoleUnprivileged } = await import('../../packages/api/dist/db/client.js');
await assertRuntimeRoleUnprivileged();
const { rows: stores } = await pool.query('SELECT slug, config FROM store');
if (stores.length !== 1 || stores[0].slug !== 'demo' || stores[0].config?.demo !== true) {
  throw new Error('Refusing to expose a database without exactly one marked demo tenant');
}
const { rows: memberships } = await pool.query('SELECT role FROM admin_user_store');
if (!memberships.length || memberships.some(row => row.role !== 'read_only')) {
  throw new Error('Demo may expose only read-only admin memberships');
}
const app = createApp();
const directory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const adminRoot = resolve(directory, '../../packages/admin/dist');
const allowedHosts = new Set(['127.0.0.1', 'localhost', 'demo.sellright.cc']);
const port = Number(process.env.DEMO_PORT ?? 4310);
const bindHost = demoBindHost(process.env.DEMO_BIND_HOST);
const buckets = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
let creatingCarts = 0;
let entering = false;
let cleanupHealthy = true;
await cleanDemo(pool);
const server = createServer(async (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json = (status, error) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error }));
  };
  try {
    const host = new URL('http://' + (req.headers.host ?? '')).hostname;
    if (!allowedHosts.has(host)) return json(403, 'Unknown demo host');
    const url = new URL(req.url ?? '/', 'http://' + req.headers.host);
    const ip = req.socket.remoteAddress ?? 'unknown';
    const minute = Math.floor(Date.now() / 60000);
    if (buckets.size > 2000) buckets.clear();
    const bucket = buckets.get(ip);
    const count = bucket?.minute === minute ? bucket.count + 1 : 1;
    buckets.set(ip, { minute, count });
    if (count > 180) return json(429, 'Demo rate limit reached');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin &&
        new URL(req.headers.origin).host !== url.host) return json(403, 'Cross-origin mutation denied');
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('User-agent: *\nDisallow: /\n'); return;
    }
    if (url.pathname === '/v1/readyz' && req.method === 'GET') {
      try {
        await assertDemoData(pool);
        if (!cleanupHealthy) throw new Error('Cleanup unhealthy');
        const counts = await demoCounts(pool);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', synthetic: true, readOnlyAdmin: true, ...counts }));
      } catch { json(503, 'Demo safety checks failed'); }
      return;
    }
    if (url.pathname === '/enter' && req.method === 'GET') {
      await assertDemoData(pool);
      const existing = await app.request('/v1/admin/me', { headers: { cookie: req.headers.cookie ?? '' } });
      if (existing.ok) { res.writeHead(303, { Location: '/' }); res.end(); return; }
      if (entering) return json(429, 'Demo sign-in busy; retry shortly');
      entering = true;
      try {
      const counts = await demoCounts(pool);
      if (counts.sessions >= 100) return json(429, 'Demo visitor capacity reached; try again later');
      const login = await app.request('/v1/admin/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'visitor@demo.example', password: process.env.DEMO_ADMIN_PASSWORD }),
      });
      if (!login.ok) return json(503, 'Demo sign-in temporarily unavailable');
      const { token } = await login.json();
      await pool.query("UPDATE session SET expires_at = now() + interval '1 hour' WHERE token_hash = $1",
        [createHash('sha256').update(token).digest('hex')]);
      res.setHeader('Set-Cookie', login.headers.getSetCookie());
      res.writeHead(303, { Location: '/' }); res.end(); return;
      } finally { entering = false; }
    }
    if (url.pathname.startsWith('/v1/')) {
      if (!allowedDemoRequest(req.method, url.pathname)) return json(403, 'Unavailable in the public read-only demo');
      await assertDemoData(pool);
      let body;
      if (!['GET', 'HEAD'].includes(req.method)) {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16384) return json(413, 'Demo request too large');
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!allowedDemoBody(url.pathname, data)) return json(400, 'Only bounded synthetic demo cart lines are accepted');
        body = JSON.stringify({ items: data.items, lines: data.lines, expectedRevision: data.expectedRevision });
        if (req.method === 'POST' && url.pathname === '/v1/shop/cart') {
          creatingCarts++;
          let allowed;
          try { allowed = (await demoCounts(pool)).carts + creatingCarts <= 1000; }
          catch (error) { creatingCarts--; throw error; }
          if (!allowed) { creatingCarts--; return json(429, 'Demo cart capacity reached'); }
        }
      }
      const headers = { 'x-store-slug': 'demo', 'content-type': 'application/json' };
      if (req.headers.cookie) headers.cookie = req.headers.cookie;
      if (req.headers.authorization) headers.authorization = req.headers.authorization;
      let response;
      try { response = await app.request(url.pathname + url.search, { method: req.method, headers, body }); }
      finally { if (req.method === 'POST' && url.pathname === '/v1/shop/cart') creatingCarts--; }
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) return json(405, 'Method not allowed');
    const shop = url.pathname === '/shop' || url.pathname.startsWith('/shop/');
    const root = shop ? directory : adminRoot;
    const relative = shop ? url.pathname.slice('/shop/'.length) : url.pathname.slice(1);
    if (shop && relative && !['shop.html', 'shop.js', 'shop.css', 'catalog.png'].includes(relative)) {
      return json(404, 'Not found');
    }
    let file = resolve(root, relative || (shop ? 'shop.html' : 'index.html'));
    if (file !== root && !file.startsWith(root + sep)) return json(403, 'Invalid path');
    let payload;
    try { payload = await readFile(file); }
    catch {
      if (extname(url.pathname)) return json(404, 'Not found');
      file = resolve(root, shop ? 'shop.html' : 'index.html');
      payload = await readFile(file);
    }
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : payload);
  } catch {
    if (!res.headersSent) json(400, 'Invalid demo request');
    else res.end();
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(port, bindHost, () => console.log('SellRight isolated demo listening on ' + bindHost + ':' + port));
const cleanup = setInterval(async () => {
  try {
    await cleanDemo(pool);
    cleanupHealthy = true;
  } catch {
    cleanupHealthy = false;
    console.error('Demo cleanup failed; readiness disabled');
  }
}, 60000);
cleanup.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(cleanup);
  server.close(() => void pool.end().then(() => process.exit(0)));
});
