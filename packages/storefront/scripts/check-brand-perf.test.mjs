// Brand perf guards (check-brand-perf.mjs): good and bad fixture trees per rule.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkBrandPerf, firstFamily, h1Weight } from './check-brand-perf.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-brand-perf.mjs');
const roots = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-brand-perf-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return root;
}
const rules = (r) => [...r.errors, ...r.warnings].map((f) => `${f.level}:${f.rule}`).sort();

const TOKENS = ":root {\n  --brand-font-display: 'Cormorant Garamond', 'Cormorant Garamond Fallback', Georgia, serif;\n  --brand-font-heading: 'Cormorant Garamond', Georgia, serif;\n  --brand-font-body: 'Plex', sans-serif;\n}\n";
const face = (family, weight, display, extra = '') => `@font-face {\n  ${display ? `font-display: ${display};` : ''}\n  font-family: '${family}';\n  font-weight: ${weight};\n  src: url('/fonts/${family.replace(/ /g, '-').toLowerCase()}-${weight}.woff2') format('woff2');${extra}\n}\n`;
const FALLBACK = "@font-face { font-family: 'Cormorant Garamond Fallback'; src: local('Georgia'); size-adjust: 101.1%; }\n";
const GOOD_FONTS = `@layer base {\n${face('Cormorant Garamond', 600, 'swap')}${face('Cormorant Garamond', 700, 'swap')}${face('Plex', 400, 'optional')}${FALLBACK}}\n`;
const GOOD_HEAD = { fontPreloads: [{ href: '/fonts/cormorant-garamond-700.woff2', type: 'font/woff2', fetchpriority: 'high' }] };
const GOOD_HOME = 'export default () => (<section><picture><source srcset="a" /><img src="h.jpg" loading="eager" fetchPriority="high" /></picture><img src="b.jpg" loading="lazy" /></section>);\n';

const good = (over = {}) => tree({ 'src/brand/tokens.css': TOKENS, 'src/brand/fonts.css': GOOD_FONTS, 'src/brand/head.json': GOOD_HEAD, 'src/brand-slots/route.home.tsx': GOOD_HOME, ...over });

test('a good brand tree is clean (body family faces are not checked)', () => {
  assert.deepEqual(rules(checkBrandPerf({ root: good() })), []);
});

test('the base tree (system Inter, no faces, no slots) is clean', () => {
  const root = tree({ 'src/brand/tokens.css': ":root { --brand-font-display: 'Inter', system-ui; --brand-font-heading: 'Inter'; }" });
  assert.deepEqual(rules(checkBrandPerf({ root })), []);
});

// 2a images
test('img-lazy-priority: loading="lazy" with fetchpriority high (the Rotten mobile LCP bug)', () => {
  const root = good({ 'src/brand-slots/pdp.gallery.tsx': 'export const G = () => <img src="a" loading="lazy" fetchpriority="high" />;\n' });
  const r = checkBrandPerf({ root });
  assert.deepEqual(rules(r), ['error:img-lazy-priority']);
  assert.equal(r.errors[0].file, 'src/brand-slots/pdp.gallery.tsx');
  assert.equal(r.errors[0].line, 1);
});

test('img-lazy-priority: an OptimizedImage with priority defaults to eager (#360); an explicit loading lazy still fails, under src/brand/**', () => {
  const root = good({ 'src/brand/configurator/C.tsx': "export const C = () => <div><OptimizedImage src={u} priority width={1} />\n<OptimizedImage src={u} priority={true} loading={'lazy'} /></div>;\n" });
  assert.deepEqual(rules(checkBrandPerf({ root })), ['error:img-lazy-priority']);
});

test('img-lazy-priority passes: eager priority, conditional loading/priority, lazy without priority, plain <img> high', () => {
  const root = good({
    'src/brand/configurator/C.tsx': "export const C = (i: number) => <div><OptimizedImage src={u} priority loading=\"eager\" /><OptimizedImage src={u} loading={i === 0 ? 'eager' : 'lazy'} priority={i === 0} /><OptimizedImage src={u} loading=\"lazy\" /><img src=\"x\" fetchPriority=\"high\" /><img src=\"y\" fetchpriority=\"auto\" loading=\"lazy\" /></div>;\n",
  });
  assert.deepEqual(rules(checkBrandPerf({ root })), []);
});

test('img-hero-lazy: the first image route.home renders is lazy', () => {
  const root = good({ 'src/brand-slots/route.home.tsx': 'export default () => (<section><img src="hero.jpg" loading="lazy" /><img src="b.jpg" loading="eager" /></section>);\n' });
  assert.deepEqual(rules(checkBrandPerf({ root })), ['error:img-hero-lazy']);
});

test('img-hero-lazy: a hero OptimizedImage without loading is lazy too', () => {
  const root = good({ 'src/brand-slots/route.home.tsx': 'export default () => <OptimizedImage src="hero.jpg" width={1} />;\n' });
  assert.deepEqual(rules(checkBrandPerf({ root })), ['error:img-hero-lazy']);
});

// 2b fonts
for (const display of ['optional', 'block', 'fallback', null]) {
  test(`font-display-swap: a display-family face with font-display ${display ?? '(unset)'} fails`, () => {
    const fonts = `${face('Cormorant Garamond', 700, display)}${face('Cormorant Garamond', 600, 'swap')}${FALLBACK}`;
    const r = checkBrandPerf({ root: good({ 'src/brand/fonts.css': fonts }) });
    assert.deepEqual(rules(r), ['error:font-display-swap']);
    assert.equal(r.errors[0].file, 'src/brand/fonts.css');
  });
}

test('font-display-swap: the heading family is checked when it differs from display; comments are ignored', () => {
  const tokens = ":root { --brand-font-display: 'Fraunces', serif; --brand-font-heading: 'Lora', serif; }";
  const fonts = `/* @font-face { font-family: 'Fraunces'; font-display: block; src: url(/x.woff2) } */\n${face('Fraunces', 400, 'swap')}${face('Lora', 700, 'optional')}@font-face { font-family: 'Fraunces Fallback'; size-adjust: 100%; src: local(Georgia) }\n@font-face { font-family: 'Lora Fallback'; size-adjust: 99%; src: local(Georgia) }\n`;
  const r = checkBrandPerf({ root: good({ 'src/brand/tokens.css': tokens, 'src/brand/theme.css': fonts, 'src/brand/fonts.css': '' }) });
  assert.deepEqual(rules(r), ['error:font-display-swap']);
  assert.match(r.errors[0].message, /'Lora' 700/);
});

test('font-fallback-face: missing, or present without size-adjust', () => {
  const noFallback = `${face('Cormorant Garamond', 700, 'swap')}`;
  assert.deepEqual(rules(checkBrandPerf({ root: good({ 'src/brand/fonts.css': noFallback }) })), ['error:font-fallback-face']);
  const noAdjust = `${noFallback}@font-face { font-family: 'Cormorant Garamond Fallback'; src: local('Georgia'); }`;
  assert.deepEqual(rules(checkBrandPerf({ root: good({ 'src/brand/fonts.css': noAdjust }) })), ['error:font-fallback-face']);
});

test('src/brand/license.css (license flow) is not scanned', () => {
  const root = good({ 'src/brand/license.css': face('Cormorant Garamond', 700, 'block') });
  assert.deepEqual(rules(checkBrandPerf({ root })), []);
});

// 2c preload
test('font-preload-high warns (never errors): 700 face not preloaded, or preloaded without fetchpriority high', () => {
  const r1 = checkBrandPerf({ root: good({ 'src/brand/head.json': { fontPreloads: [] } }) });
  assert.deepEqual(rules(r1), ['warning:font-preload-high']);
  assert.equal(r1.errors.length, 0);
  const r2 = checkBrandPerf({ root: good({ 'src/brand/head.json': { fontPreloads: [{ href: '/fonts/cormorant-garamond-700.woff2', type: 'font/woff2' }] } }) });
  assert.deepEqual(rules(r2), ['warning:font-preload-high']);
  assert.match(r2.warnings[0].message, /without fetchpriority "high"/);
  const r3 = checkBrandPerf({ root: good({ 'src/brand/head.json': '' }) });
  assert.deepEqual(rules(r3), ['warning:font-preload-high']);
});

test('font-preload-high follows the brand h1 weight (Rotten: headings 400) as well as 700', () => {
  const tokens = `${TOKENS}@layer base { :where(h1, h2, h3) { font-family: var(--font-heading); font-weight: 400; } }\n`;
  const fonts = `${face('Cormorant Garamond', 400, 'swap')}${face('Cormorant Garamond', 500, 'swap')}${FALLBACK}`;
  const r = checkBrandPerf({ root: good({ 'src/brand/tokens.css': tokens, 'src/brand/fonts.css': fonts, 'src/brand/head.json': { fontPreloads: [] } }) });
  assert.deepEqual(rules(r), ['warning:font-preload-high']);
  assert.match(r.warnings[0].message, /400/);
});

test('font-preload-high: a variable face covering 700 needs the preload; no display 700/h1 face needs nothing', () => {
  const variable = "@font-face { font-family: 'Cormorant Garamond'; font-display: swap; font-weight: 300 800; src: url('/fonts/cg-var.woff2?v=2') format('woff2'); }\n" + FALLBACK;
  assert.deepEqual(rules(checkBrandPerf({ root: good({ 'src/brand/fonts.css': variable, 'src/brand/head.json': { fontPreloads: [{ href: '/fonts/cg-var.woff2', type: 'font/woff2', fetchpriority: 'high' }] } }) })), []);
  const only600 = `${face('Cormorant Garamond', 600, 'swap')}${FALLBACK}`;
  assert.deepEqual(rules(checkBrandPerf({ root: good({ 'src/brand/fonts.css': only600, 'src/brand/head.json': { fontPreloads: [] } }) })), []);
});

test('helpers: firstFamily and h1Weight', () => {
  assert.equal(firstFamily(TOKENS, '--brand-font-display'), 'Cormorant Garamond');
  assert.equal(firstFamily(':root{--brand-font-display: var(--x)}', '--brand-font-display'), null);
  assert.equal(h1Weight([]), 700);
  assert.equal(h1Weight(['h1, h2 { font-weight: 500 }', '.hero h1{font-weight:bold}']), 700);
  assert.equal(h1Weight(['.h1x { font-weight: 300 } h10 { font-weight: 300 }']), 700);
  assert.equal(h1Weight(['@media (min-width: 1px) { h1 { font-weight: 400 !important } }']), 400);
});

test('CLI: exit 1 on errors, 0 with warnings only', () => {
  const bad = good({ 'src/brand-slots/route.home.tsx': 'export default () => <img src="h" loading="lazy" />;\n' });
  const r1 = spawnSync(process.execPath, [SCRIPT, '--root', bad], { encoding: 'utf8' });
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /route\.home\.tsx:1:\d+ img-hero-lazy/);
  const warn = good({ 'src/brand/head.json': { fontPreloads: [] } });
  const r2 = spawnSync(process.execPath, [SCRIPT, '--root', warn], { encoding: 'utf8' });
  assert.equal(r2.status, 0);
  assert.match(r2.stderr, /warning src\/brand\/head\.json/);
});

// lcp-hidden-start: the LCP image (route.home hero or any high-priority image) or an ancestor starts hidden
const REVEAL_CSS = '.x-reveal { opacity: 0; transform: translateY(28px); }\n.x-reveal.x-in { opacity: 1; }\n@keyframes xFade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; } }\n@keyframes xRise { from { transform: translateY(8px); } to { transform: none; } }\n.x-fade { animation: xFade .6s both; }\n.x-rise { animation: xRise .6s both; }\n.x-card:hover { opacity: 0; }\n@media (prefers-reduced-motion: reduce) { .x-calm { opacity: 0; } }\n';
const home = (wrapperAttrs, imgAttrs = '') => `export default () => (<section class="x-hero"><div ${wrapperAttrs}><picture><img src="h.jpg" loading="eager" fetchPriority="high" ${imgAttrs} /></picture></div></section>);\n`;

test('lcp-hidden-start: the hero sits in an opacity-0 reveal container (class)', () => {
  const root = good({ 'src/brand/styles/home.css': REVEAL_CSS, 'src/brand-slots/route.home.tsx': home('class="x-reveal"') });
  const r = checkBrandPerf({ root });
  assert.deepEqual(rules(r), ['error:lcp-hidden-start']);
  assert.match(r.errors[0].message, /x-reveal.*opacity: 0/);
});

test('lcp-hidden-start: data-reveal on an ancestor, an opacity-0 start animation on the image, a template class', () => {
  for (const [wrap, img] of [['data-reveal', ''], ['class="plain"', 'class="x-fade"'], ['class={`plain x-fade ${a}`}', '']]) {
    const root = good({ 'src/brand/styles/home.css': REVEAL_CSS, 'src/brand-slots/route.home.tsx': home(wrap, img) });
    assert.deepEqual(rules(checkBrandPerf({ root })), ['error:lcp-hidden-start'], `${wrap} ${img}`);
  }
});

test('lcp-hidden-start: a high-priority image outside route.home is checked too', () => {
  const root = good({ 'src/brand/styles/home.css': REVEAL_CSS, 'src/brand-slots/pdp.gallery.tsx': 'export const G = () => <div class="x-fade"><img src="a" fetchpriority="high" /></div>;\n' });
  assert.deepEqual(rules(checkBrandPerf({ root })), ['error:lcp-hidden-start']);
});

test('lcp-hidden-start passes: transform-only animation, state/hover/reduced-motion rules, hidden non-LCP siblings, glued template tokens', () => {
  const root = good({
    'src/brand/styles/home.css': REVEAL_CSS,
    'src/brand-slots/route.home.tsx': 'export default () => (<section class="x-hero"><div class={`x-rise x-card x-calm x-in`}><img src="h.jpg" loading="eager" fetchPriority="high" /></div><h1 class="x-fade">Hi</h1><div class="x-reveal"><img src="b.jpg" loading="lazy" /></div><div class={`pre-${a}x-reveal`}><img src="c.jpg" fetchpriority="high" loading="eager" /></div></section>);\n',
  });
  assert.deepEqual(rules(checkBrandPerf({ root })), []);
});
