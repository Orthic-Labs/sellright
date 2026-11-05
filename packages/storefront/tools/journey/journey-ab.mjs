// Interleaved A/B of the customer journey: product page (cold) -> options -> Add to cart -> drawer -> Checkout -> total visible.
//   node journey-ab.mjs <origin> <pdp> "<opt1|opt2>" <armA> <armB> [pairs=8]      arms: see net.mjs (liveA/liveB, staging ports)
// Each pair runs A and B back to back in random order (fresh context each), m375: 150 ms RTT, 1.6 Mbps down, 4x CPU.
// Reports per step the medians, the paired median difference (B - A) and in how many pairs B was faster. No order is placed.
import puppeteer from 'puppeteer-core';
import { CHROME, parseArm, stageNet, warmEdge } from './net.mjs';
import { writeFileSync } from 'node:fs';
const [origin, pdp, opts, armA, armB, pairsArg] = process.argv.slice(2);
const portA = parseArm(armA), portB = parseArm(armB);
const PAIRS = Number(pairsArg ?? 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = () => {
  const s = (window.__j = { cls: 0, lcp: 0 });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) s.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) s.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
};
const totalVisible = () => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dt = [...document.querySelectorAll('dt')].find((d) => /^total$/i.test(d.textContent.trim()));
  if (dt?.nextElementSibling && /\d/.test(dt.nextElementSibling.textContent) && vis(dt.nextElementSibling)) return true;
  const host = document.querySelector('[data-sr-host="total"]');
  return !!(host?.shadowRoot && /\d/.test(host.shadowRoot.textContent || '') && vis(host));
};
const checkoutCtl = () => [...document.querySelectorAll('a,button')].filter((e) => /checkout/i.test(e.textContent || '') && e.getBoundingClientRect().height > 0 && !e.closest('header nav'));
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run'] });
async function run(arm, port) {
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const cdp = await p.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await p.evaluateOnNewDocument(probe);
  const stat = await stageNet(p, origin, port);
  const row = { arm };
  await p.goto(origin + pdp, { waitUntil: 'load', timeout: 90000 });
  await sleep(3000);
  Object.assign(row, await p.evaluate(() => ({ pdpLcp: Math.round(window.__j.lcp), pdpCls: +window.__j.cls.toFixed(3) })));
  for (const o of (opts && opts !== '-' ? opts.split('|') : [])) { await p.evaluate((t) => [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t)?.click(), o); await sleep(700); }
  const tAdd = Date.now();
  row.added = await p.evaluate(() => { const bt = [...document.querySelectorAll('button')].find((x) => /add to (cart|bag)|^add\b/i.test(x.textContent.trim()) && !x.disabled); bt?.click(); return !!bt; });
  const vis = await p.waitForFunction(`(${checkoutCtl})().length > 0`, { timeout: 20000, polling: 100 }).then(() => true).catch(() => false);
  row.addToCheckout = vis ? Date.now() - tAdd : null;
  await sleep(1500);
  const t = Date.now();
  await p.evaluate(`(() => { const els = (${checkoutCtl})(); (els.find((e) => /proceed|checkout/i.test(e.textContent)) || els[0])?.click(); })()`);
  const ok = await p.waitForFunction(totalVisible, { timeout: 30000, polling: 50 }).then(() => true).catch(() => false);
  row.clickToTotal = ok ? Date.now() - t : null;
  // The total the customer can act on: sample the shown total until 6 s after it first appeared; the time it took its final value.
  const seen = []; const tEnd = Date.now() + 6000;
  while (Date.now() < tEnd) {
    const v = await p.evaluate(() => { const dt = [...document.querySelectorAll('dt')].find((d) => /^total$/i.test(d.textContent.trim())); const h = document.querySelector('[data-sr-host="total"]'); const sh = h?.shadowRoot ? [...h.shadowRoot.childNodes].filter((n) => n.nodeName !== 'STYLE').map((n) => n.textContent).join('') : ''; return (dt?.nextElementSibling?.textContent || sh || '').replace(/\s+/g, '').slice(0, 20); }).catch(() => '');
    const amt = (x) => parseFloat(String(x).replace(/[^0-9.]/g, '')) || 0;
    if (!seen.length || amt(seen[seen.length - 1].v) !== amt(v)) seen.push({ ms: Date.now() - t, v });
    await sleep(50);
  }
  const fin = seen[seen.length - 1];
  row.totals = seen.filter((s) => s.v).map((s) => `${s.ms}:${s.v}`).join(' ');
  row.clickToFinalTotal = fin?.v ? fin.ms : null;
  row.addToTotal = row.addToCheckout != null && row.clickToTotal != null ? row.addToCheckout + 1500 + row.clickToTotal : null;
  row.staged = stat.staged; row.composed = stat.composed; row.url = p.url().replace(origin, '');
  await ctx.close();
  return row;
}
for (const a of [portA, portB]) if (a.edge || a.cache) await warmEdge(a.port, origin);
const rows = [];
for (let i = 0; i < PAIRS; i++) {
  const order = Math.random() < 0.5 ? [['A', portA], ['B', portB]] : [['B', portB], ['A', portA]];
  const pair = {};
  for (const [arm, port] of order) { const r = await run(arm, port); r.pair = i + 1; rows.push(r); pair[arm] = r; console.log(JSON.stringify(r)); }
}
await b.close();
const KEYS = ['pdpLcp', 'addToCheckout', 'clickToTotal', 'clickToFinalTotal', 'addToTotal', 'pdpCls'];
const med = (v) => { v = v.filter((x) => typeof x === 'number').sort((a, c) => a - c); return v.length ? v[Math.floor(v.length / 2)] : null; };
console.log(`pairs=${PAIRS}  A=${portA.label} B=${portB.label}  (diff = B - A per pair, median; negative = B faster)`);
for (const k of KEYS) {
  const a = rows.filter((r) => r.arm === 'A').map((r) => r[k]); const bb = rows.filter((r) => r.arm === 'B').map((r) => r[k]);
  const d = []; for (let i = 1; i <= PAIRS; i++) { const x = rows.find((r) => r.pair === i && r.arm === 'A')?.[k]; const y = rows.find((r) => r.pair === i && r.arm === 'B')?.[k]; if (typeof x === 'number' && typeof y === 'number') d.push(y - x); }
  console.log(`${k.padEnd(14)} A=${med(a)}  B=${med(bb)}  diff=${med(d)}  B-faster=${d.filter((x) => x < 0).length}/${d.length}`);
}
writeFileSync(`ab-${Date.now()}.json`, JSON.stringify(rows, null, 1));
