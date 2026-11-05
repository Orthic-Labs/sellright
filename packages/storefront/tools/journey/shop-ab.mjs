// Interleaved A/B of landing on /shop/ (as from search or an ad), m375: 150 ms, 1.6 Mbps, 4x CPU, fresh context per run.
//   node shopab.mjs <origin> <armA> <armB> [pairs=8]      arm = staging port, "e" suffix = edge reads Worker emulated (stagenet.mjs)
// Per run: TTFB, FCP, LCP, CLS, gridVisible (first product card visible: laid out, not visibility:hidden), cards shown then hidden.
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';
import { CHROME, parseArm, stageNet, warmEdge } from './net.mjs';
const [origin, a, bArm, pairsArg] = process.argv.slice(2);
const A = parseArm(a), B = parseArm(bArm), PAIRS = Number(pairsArg ?? 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = () => {
  const s = (window.__j = { cls: 0, lcp: 0, grid: 0, hiddenAfterShown: 0 }); const shown = new Set();
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) s.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) s.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  const tick = () => {
    for (const c of document.querySelectorAll('a[href^="/products/"]')) {
      if (c.closest('header,nav,footer')) continue;
      const r = c.getBoundingClientRect(); const vis = r.width > 0 && r.height > 0 && r.top < innerHeight && c.checkVisibility({ visibilityProperty: true });
      const k = c.getAttribute('href');
      if (vis) { if (!s.grid) s.grid = performance.now(); shown.add(k); } else if (shown.has(k)) { s.hiddenAfterShown++; shown.delete(k); }
    }
    if (performance.now() < 15000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run'] });
for (const arm of [A, B]) if (arm.edge || arm.cache) await warmEdge(arm.port, origin);
async function run(arm) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage();
  await p.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const cdp = await p.createCDPSession(); await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await p.evaluateOnNewDocument(probe);
  const stat = await stageNet(p, origin, arm);
  await p.goto(origin + '/shop/', { waitUntil: 'load', timeout: 90000 });
  await sleep(5000);
  const row = { arm: arm.label, ...(await p.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const f = performance.getEntriesByName('first-contentful-paint')[0]; const j = window.__j; return { ttfb: Math.round(n.responseStart), fcp: f ? Math.round(f.startTime) : null, lcp: Math.round(j.lcp), cls: +j.cls.toFixed(3), gridVisible: j.grid ? Math.round(j.grid) : null, hiddenAfterShown: j.hiddenAfterShown, cards: [...document.querySelectorAll('a[href^="/products/"]')].filter((c) => !c.closest('header,nav,footer') && c.checkVisibility({ visibilityProperty: true })).length, edge: !!document.querySelector('meta[name=sr-edge]') }; })), composed: stat.composed };
  await ctx.close(); return row;
}
const rows = [];
for (let i = 0; i < PAIRS; i++) {
  const order = Math.random() < 0.5 ? [A, B] : [B, A];
  for (const arm of order) { const r = await run(arm); r.pair = i + 1; r.side = arm === A ? 'A' : 'B'; rows.push(r); console.log(JSON.stringify(r)); }
}
await b.close();
const med = (v) => { v = v.filter((x) => typeof x === 'number').sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
console.log(`pairs=${PAIRS} A=${A.label} B=${B.label} (diff = B - A, median; negative = B faster)`);
for (const k of ['ttfb', 'fcp', 'gridVisible', 'lcp', 'cls', 'hiddenAfterShown', 'cards']) {
  const d = []; for (let i = 1; i <= PAIRS; i++) { const x = rows.find((r) => r.pair === i && r.side === 'A')?.[k]; const y = rows.find((r) => r.pair === i && r.side === 'B')?.[k]; if (typeof x === 'number' && typeof y === 'number') d.push(y - x); }
  console.log(`${k.padEnd(17)} A=${med(rows.filter((r) => r.side === 'A').map((r) => r[k]))}  B=${med(rows.filter((r) => r.side === 'B').map((r) => r[k]))}  diff=${med(d)}  B-faster=${d.filter((x) => x < 0).length}/${d.length}`);
}
writeFileSync(`shopab-${Date.now()}.json`, JSON.stringify(rows, null, 1));
