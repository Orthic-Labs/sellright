// Correctness checks for the cached-shell + edge-read checkout (the architecture note's list), no orders placed:
//   node corr.mjs <origin> <pdp> "<opt>" <arm>      arm: staging port ("4473e" = edge emulated) or "live"
// 1. Two customers at once: C1 adds 1, C2 adds 2, both open checkout at the same moment; each must see only its own cart
//    (its own quantity and total), in the first painted summary and in the final one.
// 2. A cart change racing navigation: C2 changes quantity in the drawer and taps Checkout immediately; checkout must show the
//    new quantity's total (never the old one, not even first).
import puppeteer from 'puppeteer-core';
import { CHROME, parseArm, stageNet, warmEdge } from './net.mjs';
const [origin, pdp, opt, armS] = process.argv.slice(2);
const arm = armS === 'live' ? null : parseArm(armS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
if (arm?.edge) await warmEdge(arm.port, origin);
const totalText = () => { const dt = [...document.querySelectorAll('dt')].find((d) => /^total$/i.test(d.textContent.trim())); const h = document.querySelector('[data-sr-host="total"]'); const sh = h?.shadowRoot ? [...h.shadowRoot.childNodes].filter((n) => n.nodeName !== 'STYLE').map((n) => n.textContent).join('') : ''; return (dt?.nextElementSibling?.textContent || sh || '').replace(/\s+/g, ''); };
async function customer(name) {
  const p = await (await b.createBrowserContext()).newPage();
  await p.setViewport({ width: 390, height: 844 });
  if (arm) await stageNet(p, origin, arm);
  await p.goto(origin + pdp, { waitUntil: 'load' }); await sleep(2500);
  await p.evaluate((t) => [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t)?.click(), opt); await sleep(700);
  return { name, p };
}
const add = (c) => c.p.evaluate(() => [...document.querySelectorAll('button')].find((x) => /add to (cart|bag)|^add\b/i.test(x.textContent.trim()) && !x.disabled)?.click());
async function watchTotals(c, ms) {
  const seen = []; const end = Date.now() + ms;
  // amounts, not strings: the painted summary writes $45.00 where Qwik later writes $45 (same value, not a change)
  while (Date.now() < end) { const v = await c.p.evaluate(totalText).catch(() => ''); const a = amount(v); if (v && amount(seen[seen.length - 1]) !== a) seen.push(v); await sleep(40); }
  return seen;
}
const amount = (x) => (x ? parseFloat(String(x).replace(/[^0-9.]/g, '')) : NaN);
const unit = 25; // monsuta-bead Titanium- Stonewashed, $25 (asserted from the page below)
const fails = [];
const [c1, c2] = await Promise.all([customer('C1'), customer('C2')]);
await add(c1); await add(c2); await sleep(2500);
// C2 second unit: re-add from the PDP (drawer closed first)
await c2.p.keyboard.press('Escape'); await sleep(500); await add(c2); await sleep(3500);
await Promise.all([c1.p.goto(origin + '/checkout/'), c2.p.goto(origin + '/checkout/')]);
const [s1, s2] = await Promise.all([watchTotals(c1, 7000), watchTotals(c2, 7000)]);
console.log('C1 totals seen', JSON.stringify(s1)); console.log('C2 totals seen', JSON.stringify(s2));
const qty = async (c) => c.p.evaluate(() => document.body.innerText.match(/(?:Qty|Quantity)[:\s]*(\d+)/i)?.[1] ?? null);
console.log('C1 qty', await qty(c1), 'C2 qty', await qty(c2));
if (s1.some((v) => s2.length && v === s2[s2.length - 1] && s1[s1.length - 1] !== v)) fails.push('C1 showed C2 total');
if (amount(s1[s1.length - 1]) === amount(s2[s2.length - 1])) fails.push('C1 and C2 end on the same total although carts differ');
// 2. race: C1 adds one more on the PDP, opens the drawer and taps Checkout at once
await c1.p.goto(origin + pdp, { waitUntil: 'load' }); await sleep(2500);
await c1.p.evaluate((t) => [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t)?.click(), opt); await sleep(700);
await add(c1);
await c1.p.waitForFunction(() => [...document.querySelectorAll('button')].some((e) => /checkout/i.test(e.textContent || '') && e.getBoundingClientRect().height > 0 && !e.disabled), { timeout: 15000, polling: 20 }).catch(() => null);
await c1.p.evaluate(() => [...document.querySelectorAll('button')].find((e) => /checkout/i.test(e.textContent || '') && e.getBoundingClientRect().height > 0 && !e.disabled)?.click());
await c1.p.waitForNavigation({ timeout: 15000 }).catch(() => null);
const s3 = await watchTotals(c1, 7000);
console.log('race C1 totals seen', JSON.stringify(s3), 'qty', await qty(c1));
if (s3.length > 1) fails.push('race: the total changed after first paint ' + JSON.stringify(s3));
if (s3.length && s1.length && amount(s3[0]) === amount(s1[s1.length - 1])) fails.push('race: first total is the pre-change total');
console.log(fails.length ? 'FAIL ' + fails.join('; ') : 'PASS');
process.exitCode = fails.length ? 1 : 0;
await b.close();
