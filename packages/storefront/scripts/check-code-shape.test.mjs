import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PACKAGE_ROOT, loadLayers } from './check-imports.mjs';
import { checkBaseL2Shape, checkOverlayShape, shapeFindings } from './check-code-shape.mjs';
import { buildTree, loadSnippets } from './fixtures/layers/build-tree.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-code-shape.mjs');
const LAYERS = path.join(PACKAGE_ROOT, 'layers.json');
const layers = loadLayers();
const tree = buildTree();
after(() => tree.cleanup());

const { findings } = checkOverlayShape({ root: tree.root, layers, files: tree.overlay.map((o) => o.rel) });
const rulesFor = (rel) => findings.filter((f) => f.file === rel).map((f) => f.rule);

// Every negative fixture fails, as an L3 file and again as an L2 eject, with the rule its header names.
for (const sn of loadSnippets('negative')) {
  for (const as of ['L3', 'L2-eject']) {
    const entry = tree.overlay.find((o) => o.id === sn.id && o.as === as);
    if (sn.expect.shape.length === 0) continue; // import-only negatives are covered by check-imports.test.mjs
    test(`negative ${sn.id} as ${as}: ${sn.expect.shape.join(', ')}`, () => {
      const got = rulesFor(entry.rel);
      for (const rule of sn.expect.shape) assert.ok(got.includes(rule), `${entry.rel}: expected ${rule}, got [${got}]`);
    });
  }
}

for (const sn of loadSnippets('positive')) {
  for (const as of ['L3', 'L2-eject']) {
    const entry = tree.overlay.find((o) => o.id === sn.id && o.as === as);
    test(`positive ${sn.id} as ${as}: no code-shape finding`, () => {
      assert.deepEqual(findings.filter((f) => f.file === entry.rel), []);
    });
  }
}

test('every negative fixture declares at least one expected rule', () => {
  for (const sn of loadSnippets('negative')) assert.ok(sn.expect.shape.length + sn.expect.imports.length > 0, sn.id);
});

test('each rule class is exercised by some negative fixture in both file kinds', () => {
  for (const rule of ['definition-call', 'global-network', 'orchestration-call', 'import-forbidden']) {
    for (const as of ['L3', 'L2-eject']) {
      const hit = tree.overlay.some((o) => o.as === as && o.kind === 'negative' && rulesFor(o.rel).includes(rule));
      assert.ok(hit, `${rule} as ${as}`);
    }
  }
});

// ------------------------------------------------------------------------------------------------ rule edges

const shape = (src, file = 'src/brand/x.tsx') => shapeFindings(layers, file, src).map((f) => f.rule);

test('definition calls: direct, aliased, namespace, element access and a bare reference all count', () => {
  assert.deepEqual(new Set(shape("import { routeLoader$ } from '@qwik.dev/router'; export const a = routeLoader$(() => 1);")), new Set(['definition-call']));
  assert.ok(shape("import { routeAction$ as ra } from '@qwik.dev/router'; export const a = ra(() => 1);").includes('definition-call'));
  assert.ok(shape("import * as q from '@qwik.dev/router'; export const a = q.globalAction$(() => 1);").includes('definition-call'));
  assert.ok(shape("import * as q from '@qwik.dev/router'; export const a = q['server$'](() => 1);").includes('definition-call'));
  assert.ok(shape("import { routeLoader$ } from '@qwik.dev/router'; const f = routeLoader$; export { f };").includes('definition-call'));
});

test('re-exporting a platform loader or action is allowed; reading a loader hook is allowed', () => {
  assert.deepEqual(shape("export { useProbeLoader, useProbeAction } from '~/platform/probe';"), []);
  assert.deepEqual(shape("import { useProbeLoader } from '~/platform/probe'; export const v = () => useProbeLoader();"), []);
});

test('network: property names that merely look like fetch are not flagged, globals are', () => {
  assert.deepEqual(shape('export const a = (api: { fetch: () => void }) => api.fetch();'), []);
  assert.deepEqual(shape("export const a = <Foo fetch={1} />;"), []);
  assert.deepEqual(shape('export const o = { fetch: 1 };'), []);
  assert.deepEqual(shape('export const w: WebSocket | null = null;'), []);
  assert.ok(shape("export const a = () => fetch('/x');").includes('global-network'));
  assert.ok(shape("export const a = () => globalThis['fetch']('/x');").includes('global-network'));
  assert.ok(shape("export const a = () => self.fetch('/x');").includes('global-network'));
  assert.ok(shape("export const a = (n: Navigator) => n.sendBeacon('/x');").includes('global-network'));
});

test('network: a global object wrapped in parentheses, assertions or non-null is still the global object', () => {
  for (const src of [
    "export const a = () => (globalThis).fetch('/shop-api');",
    "export const a = () => ((window)).fetch('/shop-api');",
    "export const a = () => (self)!.fetch('/shop-api');",
    "export const a = () => (window as any).fetch('/shop-api');",
    "export const a = () => ((globalThis as unknown) as Window).fetch('/shop-api');",
    "export const a = () => (globalThis as any)['fetch']('/shop-api');",
    "export const a = () => (global satisfies object).fetch('/shop-api');",
    "export const a = () => new (window as any).WebSocket('wss://example.invalid');",
    "export const a = () => new (self)!.XMLHttpRequest();",
  ]) assert.ok(shape(src).includes('global-network'), src);
  assert.ok(shape("export const a = () => (<any>globalThis).fetch('/shop-api');", 'src/brand/x.ts').includes('global-network'), 'angle-bracket assertion');
  // a wrapped receiver that is NOT a global object stays allowed, like the unwrapped form
  assert.deepEqual(shape('export const a = (api: { fetch: () => void }) => (api).fetch();'), []);
  assert.deepEqual(shape('export const a = (api: any) => (api as { fetch: () => void }).fetch();'), []);
  assert.deepEqual(shape("export const a = (api: any) => (api!)['fetch']();"), []);
});

test('orchestration: names, gateway call targets and stock helpers are flagged; a gateway-named JSX element is not a call', () => {
  assert.ok(shape("import { placeOrder as po } from '~/platform/checkout'; export const a = () => po();").includes('orchestration-call'));
  assert.ok(shape('export const a = () => refreshCartStock();').includes('orchestration-call'));
  assert.ok(shape('export const a = (s: any) => s.stripe.confirmPayment({});').includes('orchestration-call'));
  assert.ok(shape('export const a = () => new Stripe();').includes('orchestration-call'));
  assert.ok(shape('export const a = () => refreshStockNow();').includes('orchestration-call'));
  assert.deepEqual(shape('export const a = () => <Sezzle />;'), []);
  assert.deepEqual(shape('export const a = (cart: { count: number }) => cart.count;'), []);
});

test('findings carry file, line and column', () => {
  const [f] = shapeFindings(layers, 'src/brand/x.ts', "\n\nexport const a = () => fetch('/x');\n");
  assert.equal(f.file, 'src/brand/x.ts');
  assert.equal(f.line, 3);
  assert.equal(f.col, 24);
});

// ------------------------------------------------------------------------------------------------ base L2 report mode

test('base L2: orchestration in base-reviewed L2 code is listed, overlay files are not scanned, enforcement decides the exit', () => {
  const r = checkBaseL2Shape({ root: tree.root, layers, overlay: tree.overlay.map((o) => o.rel) });
  assert.deepEqual([...new Set(r.findings.map((f) => f.file))], ['src/components/legacy/LegacyCart.tsx']);
  assert.ok(r.findings.every((f) => f.rule === 'orchestration-call'));
});

function cli(extra, layersFile = LAYERS) {
  return spawnSync(process.execPath, [SCRIPT, '--root', tree.root, '--layers', layersFile, ...extra], { encoding: 'utf8' });
}

test('CLI --base: report mode lists the call and exits 0; block mode exits 1', () => {
  const report = cli(['--base']);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /report src\/components\/legacy\/LegacyCart\.tsx:\d+:\d+ orchestration-call/);
  assert.match(report.stdout, /enforcement report/);

  const blockLayers = path.join(tree.root, 'layers.block.json');
  const l = structuredClone(layers);
  l.codeShape.baseL2Enforcement = 'block';
  fs.writeFileSync(blockLayers, JSON.stringify(l));
  const block = cli(['--base'], blockLayers);
  assert.equal(block.status, 1, block.stdout);
  assert.match(block.stdout, /FAIL src\/components\/legacy\/LegacyCart\.tsx/);
});

test('CLI overlay mode: the fixture overlay fails, the positives alone pass, base alone passes', () => {
  assert.equal(cli([]).status, 1);
  const positives = tree.overlay.filter((o) => o.kind === 'positive').map((o) => o.rel);
  const ok = cli(positives);
  assert.equal(ok.status, 0, ok.stderr);
  const none = spawnSync(process.execPath, [SCRIPT, '--root', PACKAGE_ROOT, '--layers', LAYERS], { encoding: 'utf8' });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /base alone/);
});
