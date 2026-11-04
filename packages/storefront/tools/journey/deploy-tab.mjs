// Open a live PDP, keep the tab open across a deploy (until ./oldtab.go exists), then shop in that same tab: missing chunks or
// page errors after the deploy fail it. No order is placed.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { CHROME } from './net.mjs';
const [origin, pdp, opt] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const p = await (await b.createBrowserContext()).newPage();
const bad = []; p.on('response', (r) => { if (r.status() >= 400 && /\/build\/|\.js(\?|$)/.test(r.url())) bad.push(r.status() + ' ' + new URL(r.url()).pathname); });
p.on('pageerror', (e) => bad.push('pageerror ' + String(e).slice(0, 160)));
await p.goto(origin + pdp, { waitUntil: 'load' }); await sleep(3000);
const before = await p.evaluate(() => document.querySelector('script[src*="/build/"],link[href*="/build/"]')?.getAttribute('src') || document.querySelector('link[rel=modulepreload]')?.getAttribute('href'));
console.log('tab open at', new Date().toISOString(), 'build asset', before);
while (!existsSync(process.env.GO_FILE || 'deploy-tab.go')) await sleep(2000);
console.log('deploy done; using the old tab at', new Date().toISOString());
await p.evaluate((t) => [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t)?.click(), opt); await sleep(800);
await p.evaluate(() => [...document.querySelectorAll('button')].find((x) => /add to (cart|bag)|^add\b/i.test(x.textContent.trim()) && !x.disabled)?.click());
const drawer = await p.waitForFunction(() => [...document.querySelectorAll('button')].some((e) => /checkout/i.test(e.textContent || '') && e.getBoundingClientRect().height > 0), { timeout: 20000 }).then(() => true).catch(() => false);
await sleep(1500);
await p.evaluate(() => [...document.querySelectorAll('button')].find((e) => /checkout/i.test(e.textContent || '') && e.getBoundingClientRect().height > 0 && !e.disabled)?.click());
await p.waitForNavigation({ timeout: 20000 }).catch(() => null); await sleep(4000);
const total = await p.evaluate(() => { const dt = [...document.querySelectorAll('dt')].find((d) => /^total$/i.test(d.textContent.trim())); return dt?.nextElementSibling?.textContent?.trim() || null; });
console.log(JSON.stringify({ drawer, url: p.url().replace(origin, ''), total, failures: bad }));
console.log(drawer && total && !bad.length ? 'PASS' : 'FAIL');
process.exitCode = drawer && total && !bad.length ? 0 : 1;
await b.close();
