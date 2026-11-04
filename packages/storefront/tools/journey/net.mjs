// Staging network for the A/B harnesses: serves the store's pages from a staging port (over the SSH tunnel) instead of the live
// origin, with the same delay model for every arm, and optionally EMULATES the edge reads Worker (packages/storefront/edge/
// edge-reads.worker.js) for /shop/ and /checkout/:
//   arm "4472"   documents and q-data from the staging origin: the origin trip (tunnel) + 150 ms + bytes / 200 kB/s, overlapped.
//   arm "4473e"  same, but a /shop/ or /checkout/ document is composed like the Worker does: the shell from an "edge cache" (a
//                local copy, fetched once from the origin like Cloudflare's cache), the live read started at request arrival
//                against the origin (with the visitor's cookie and country), the meta + JSON block inserted. The response is
//                delivered when max(read done, 150 ms + bytes / 200 kB/s): the block arrives with the body's end, as when
//                streaming. (Not modelled, so the Worker is favoured LESS than live: the head streaming ahead of the block.)
// /v1 and /assets always go to the live store (Chrome's own network emulation applies to them).
import http from 'node:http';
import zlib from 'node:zlib';
/** Bytes on the wire: text is sent brotli-compressed by the edge, so the delay model charges the compressed size. */
const wire = (r) => (/text|json|javascript|css|svg|xml/.test(String(r.headers['content-type'] || '')) ? zlib.brotliCompressSync(r.body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }).length : r.body.length);
/** Chrome to drive: env CHROME, else the usual Windows path. */
export const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const IPCOUNTRY = process.env.IPCOUNTRY || 'IN';
const EDGE_PAGES = ['/shop/', '/checkout/'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// "4473e" = cached shell + edge reads Worker emulated; "4473c" = cached shell served from the cache (a HIT), no Worker.
export function parseArm(s) { s = String(s); if (/^live/.test(s)) return { live: true, ab: s === 'liveA', label: s, port: 0 }; return { port: Number(s.replace(/[ec]$/, '')), edge: /e$/.test(s), cache: /c$/.test(s), label: s }; }
function get(port, url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ host: '127.0.0.1', port, path: u.pathname + u.search, method, headers: { ...headers, host: u.host, 'accept-encoding': 'identity', 'cf-ipcountry': IPCOUNTRY } }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const shellCache = new Map(); // port+path -> { at, res }
async function edgeShell(port, url) {
  const k = port + new URL(url).pathname; const hit = shellCache.get(k);
  if (hit && Date.now() - hit.at < 120000) return hit.res;
  const res = await get(port, url, 'GET', { accept: 'text/html' }); // no cookie: what the cache holds
  if (res.status === 200 && String(res.headers['x-sr-edge'] || '').startsWith('cacheable')) shellCache.set(k, { at: Date.now(), res });
  return res;
}
export async function warmEdge(port, origin) { if (!port) return; for (const p of EDGE_PAGES) await edgeShell(port, origin + p); }
const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** The reads a cached shell declares (its Link rel=preload as=fetch entries), as the Worker takes them. */
export function linkKeys(link) {
  const out = [];
  for (const e of String(link || '').split(/,(?=\s*<)/)) { const m = e.trim().match(/^<([^>]*)>(.*)$/); if (!m) continue; const ps = m[2].toLowerCase(); if (/;\s*rel="?preload/.test(ps) && /;\s*as="?fetch/.test(ps) && m[1].startsWith('/') && !m[1].startsWith('//') && !out.includes(m[1])) out.push(m[1]); }
  return out.slice(0, 6);
}
function compose(shell, keys, reads, reqCookie) {
  let html = shell.body.toString('utf8');
  html = html.replace(/<head[^>]*>/i, (m) => `${m}<meta name="sr-edge" content="${attr(keys.join(' '))}">`);
  const blocks = keys.map((k, i) => { const r = reads[i]; const ok = r && r.status === 200 && String(r.headers['content-type'] || '').includes('application/json'); return `<script type="application/json" data-sr-edge="${attr(k)}" data-ok="${ok ? 1 : 0}">${ok ? r.body.toString('utf8').replace(/</g, '\\u003c') : ''}</script>`; }).join('');
  const i = html.lastIndexOf('</body>'); html = i >= 0 ? html.slice(0, i) + blocks + html.slice(i) : html + blocks;
  const headers = { ...shell.headers, 'cache-control': 'private, no-store', 'x-sr-edge-reads': keys.join(' ') };
  if (!/(?:^|;\s*)countryCode=/.test(reqCookie || '')) headers['set-cookie'] = `countryCode=${IPCOUNTRY}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`;
  if (headers.link) { const kept = String(headers.link).split(/,(?=\s*<)/).map((s) => s.trim()).filter((e) => !keys.some((k) => e.startsWith(`<${k}>`))); if (kept.length) headers.link = kept.join(', '); else delete headers.link; }
  return { status: 200, headers, body: Buffer.from(html, 'utf8') };
}
/** Installs request interception on a page for one arm. Returns a counter object. */
export async function stageNet(p, origin, arm) {
  if (arm.live) { // the live store; arm A asks for the never-cached render of /shop/ and /checkout/ (a query URL is never a shell)
    const stat = { staged: 0, composed: 0 };
    if (!arm.ab) return stat;
    await p.setRequestInterception(true);
    p.on('request', (req) => { const u = new URL(req.url()); if (req.resourceType() === 'document' && req.method() === 'GET' && u.origin === origin && !u.search && EDGE_PAGES.includes(u.pathname)) { stat.staged++; req.continue({ url: req.url() + '?sr_ab=1' }); } else req.continue(); });
    return stat;
  }
  await p.setRequestInterception(true);
  const stat = { staged: 0, composed: 0 };
  p.on('request', async (req) => {
    const url = req.url();
    if (!url.startsWith(origin) || /^\/(v1|assets)\//.test(new URL(url).pathname)) return req.continue();
    try {
      const t = Date.now(); const u = new URL(url);
      const isDoc = (arm.edge || arm.cache) && req.method() === 'GET' && !u.search && req.resourceType() === 'document' && EDGE_PAGES.includes(u.pathname);
      let r;
      const hdr = req.headers();
      const shell = isDoc ? await edgeShell(arm.port, url) : null;
      const keys = shell && String(shell.headers['x-sr-edge'] || '').startsWith('cacheable') ? linkKeys(shell.headers.link) : [];
      if (arm.cache && shell && String(shell.headers['x-sr-edge'] || '').startsWith('cacheable')) {
        r = shell; stat.composed++; // a cache HIT: the shell as stored, the page reads its live values itself
      } else if (keys.length) {
        const reads = await Promise.all(keys.map((k) => get(arm.port, origin + k, 'GET', { accept: 'application/json', ...(hdr.cookie ? { cookie: hdr.cookie } : {}) }).catch(() => null)));
        if (process.env.EDGEDBG) console.error('[edge]', u.pathname, keys.join(' '), reads.map((x) => x && x.status));
        r = compose(shell, keys, reads, hdr.cookie); stat.composed++;
      } else {
        r = await get(arm.port, url, req.method(), req.headers(), req.postData());
      }
      stat.staged++;
      const h = {}; for (const [k, v] of Object.entries(r.headers)) if (!['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(k)) h[k] = Array.isArray(v) ? v.join(', ') : String(v);
      await sleep(Math.max(0, 150 + wire(r) / 200 - (Date.now() - t)));
      req.respond({ status: r.status, headers: h, body: r.body });
    } catch { req.abort(); }
  });
  return stat;
}
