import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PACKAGE_ROOT, checkOverlayImports, classify, loadLayers, matchGlob, normalizeRel, validateTree } from './check-imports.mjs';
import { buildTree, loadSnippets } from './fixtures/layers/build-tree.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-imports.mjs');
const layers = loadLayers();
const tree = buildTree();
after(() => tree.cleanup());

// ------------------------------------------------------------------------------------------------ layers.json globs

test('glob: per-segment matching, ** spans segments, brackets are literal', () => {
  assert.ok(matchGlob('src/routes/products/**/ProductPageView.tsx', 'src/routes/products/[...slug]/ProductPageView.tsx'));
  assert.ok(matchGlob('src/routes/products/**/ProductPageView.tsx', 'src/routes/products/ProductPageView.tsx'));
  assert.ok(matchGlob('src/routes/products/**/ProductPageView.tsx', 'src/routes/products/a/b/ProductPageView.tsx'));
  assert.equal(matchGlob('src/routes/products/**/ProductPageView.tsx', 'src/routes/products/UnexpectedProductPageView.tsx'), false);
  assert.equal(matchGlob('src/routes/products/**/ProductPageView.tsx', 'src/routes/products/[...slug]/UnexpectedProductPageView.tsx'), false);
  assert.equal(matchGlob('src/entry.*', 'src/entry.ssr.tsx'), true);
  assert.equal(matchGlob('src/*.ts', 'src/a/b.ts'), false);
  assert.equal(matchGlob('src/platform/**', 'src/platform/a/b.ts'), true);
  assert.equal(matchGlob('src/platform/**', 'src/platformx/a.ts'), false);
});

test('normalizeRel rejects absolute, traversal and backslash paths', () => {
  for (const bad of ['/etc/passwd', '../x', 'src/../x', 'src//x', 'src\\x', '', './x']) assert.throws(() => normalizeRel(bad), bad);
});

test('classify: representative paths', () => {
  const layerOf = (p) => classify(layers, p)?.layer ?? null;
  assert.equal(layerOf('src/platform/probe.ts'), 'L1');
  assert.equal(layerOf('src/routes/shop/index.tsx'), 'L1');
  assert.equal(layerOf('src/routes/products/[...slug]/index.tsx'), 'L1');
  assert.equal(layerOf('src/routes/products/[...slug]/ProductPageView.tsx'), 'L3');
  assert.equal(layerOf('src/routes/products/[...slug]/UnexpectedProductPageView.tsx'), 'L1');
  assert.equal(layerOf('src/components/header/header.tsx'), 'L2');
  assert.equal(layerOf('src/components/payment/NMI.tsx'), 'L1');
  assert.equal(layerOf('src/components/checkout/CheckoutPageView.tsx'), 'L1');
  assert.equal(layerOf('src/components/cart/Cart.tsx'), 'L1');
  assert.equal(layerOf('src/brand/tokens.css'), 'L3');
  assert.equal(layerOf('src/brand-slots/payment.badges.tsx'), 'L3');
  assert.equal(layerOf('public/brand/logo.svg'), 'L3');
  assert.equal(layerOf('src/theme/theme.config.ts'), null);
  assert.equal(layerOf('public/favicon.ico'), null);
});

test('assetExceptions: both Sezzle assets are L3 at their exact paths, a near-miss is not', () => {
  for (const p of ['public/sezzle-color.svg', 'public/sezzle-white.svg']) {
    assert.deepEqual(classify(layers, p)?.layer, 'L3', p);
    assert.match(classify(layers, p).via, /^assetExceptions:/);
  }
  assert.equal(classify(layers, 'public/sezzle-color.svg.bak'), null);
  assert.equal(classify(layers, 'public/other/sezzle-color.svg'), null);
});

test('a path matching two layers throws, naming both', () => {
  const twoLayers = structuredClone(layers);
  twoLayers.layers.L2.include.push('src/brand/**');
  assert.throws(() => classify(twoLayers, 'src/brand/tokens.css'), /ambiguous layer for src\/brand\/tokens\.css: L2 .* and L3/);
  const assetClash = structuredClone(layers);
  assetClash.layers.L1.include.push('public/sezzle-color.svg');
  assert.throws(() => classify(assetClash, 'public/sezzle-color.svg'), /ambiguous/);
});

test('loadLayers rejects malformed globs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-layers-json-'));
  try {
    for (const [name, mutate] of [
      ['partial ** segment', (l) => l.layers.L1.include.push('src/a**b')],
      ['absolute glob', (l) => l.layers.L1.include.push('/src/a')],
      ['traversal glob', (l) => l.layers.L1.include.push('src/../a')],
      ['bad asset layer', (l) => { l.assetExceptions[0].layer = 'L9'; }],
      ['empty layer', (l) => { l.layers.L3.include = []; }],
    ]) {
      const l = structuredClone(layers);
      mutate(l);
      const file = path.join(dir, `${name.replace(/\W+/g, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify(l));
      assert.throws(() => loadLayers(file), name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real src tree classifies without ambiguity and the report lists what is unclassified', () => {
  const { counts, ambiguous, unclassified } = validateTree(PACKAGE_ROOT, layers);
  assert.deepEqual(ambiguous, []);
  assert.ok(counts.L1 > 0 && counts.L2 > 0 && counts.L3 >= 1);
  assert.ok(unclassified.every((p) => !p.startsWith('src/platform/') && !p.startsWith('src/components/')), 'every platform and component file has a layer');
});

// ------------------------------------------------------------------------------------------------ fixtures

const { findings } = checkOverlayImports({ root: tree.root, layers, files: tree.overlay.map((o) => o.rel) });
const rulesFor = (rel) => findings.filter((f) => f.file === rel).map((f) => f.rule);

for (const sn of loadSnippets('negative')) {
  for (const as of ['L3', 'L2-eject']) {
    const entry = tree.overlay.find((o) => o.id === sn.id && o.as === as);
    if (sn.expect.imports.length === 0) continue; // shape-only negatives are covered by check-code-shape.test.mjs
    test(`negative ${sn.id} as ${as}: import findings ${sn.expect.imports.join(', ')}`, () => {
      const got = rulesFor(entry.rel);
      for (const rule of sn.expect.imports) assert.ok(got.includes(rule), `${entry.rel}: expected ${rule}, got [${got}]`);
    });
  }
}

for (const sn of loadSnippets('positive')) {
  for (const as of ['L3', 'L2-eject']) {
    const entry = tree.overlay.find((o) => o.id === sn.id && o.as === as);
    test(`positive ${sn.id} as ${as}: no import finding`, () => {
      assert.deepEqual(findings.filter((f) => f.file === entry.rel), []);
    });
  }
}

test('placement: an overlay code file in L1 or in no layer is rejected, a non-code file is not looked at', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-place-'));
  try {
    for (const rel of ['src/routes/x/index.tsx', 'src/theme/t.ts', 'src/brand/ok.ts', 'public/favicon.ico']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), rel.endsWith('.ts') || rel.endsWith('.tsx') ? 'export const a = 1;\n' : 'x');
    }
    const r = checkOverlayImports({ root, layers, files: ['src/routes/x/index.tsx', 'src/theme/t.ts', 'src/brand/ok.ts', 'public/favicon.ico'] });
    assert.deepEqual(r.findings.map((f) => `${f.file} ${f.rule}`).sort(), ['src/routes/x/index.tsx layer-l1-overlay', 'src/theme/t.ts layer-unclassified']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('placement: a declared deploy file may sit in no layer; nothing else is exempted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-deploy-'));
  try {
    for (const rel of ['ecosystem.config.cjs', 'src/theme/t.ts', 'src/routes/x/index.tsx']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), 'module.exports = {};\n');
    }
    const rules = (files, deployFiles) => checkOverlayImports({ root, layers, files, deployFiles }).findings.map((f) => `${f.file} ${f.rule}`).sort();
    assert.deepEqual(rules(['ecosystem.config.cjs']), ['ecosystem.config.cjs layer-unclassified'], 'undeclared: still rejected');
    assert.deepEqual(rules(['ecosystem.config.cjs'], ['ecosystem.config.cjs']), [], 'declared deploy file is accepted');
    assert.deepEqual(rules(['src/theme/t.ts'], ['ecosystem.config.cjs']), ['src/theme/t.ts layer-unclassified'], 'a source file that is not declared stays strict');
    assert.deepEqual(rules(['src/routes/x/index.tsx'], ['src/routes/x/index.tsx']), ['src/routes/x/index.tsx layer-l1-overlay'], 'declaring an L1 file does not unlock it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a symlink or a missing file in the overlay list is a finding, not a silent skip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-link-'));
  try {
    fs.mkdirSync(path.join(root, 'src/brand'), { recursive: true });
    fs.writeFileSync(path.join(root, 'real.ts'), 'export const a = 1;\n');
    fs.symlinkSync(path.join(root, 'real.ts'), path.join(root, 'src/brand/link.ts'));
    const r = checkOverlayImports({ root, layers, files: ['src/brand/link.ts', 'src/brand/gone.ts'] });
    assert.deepEqual(r.findings.map((f) => f.rule).sort(), ['file-missing', 'file-symlink']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an import that resolves outside the project root is rejected', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-outer-'));
  try {
    const root = path.join(outer, 'proj');
    fs.mkdirSync(path.join(root, 'src/brand'), { recursive: true });
    fs.writeFileSync(path.join(outer, 'secret.ts'), 'export const s = 1;\n');
    fs.writeFileSync(path.join(root, 'src/brand/a.ts'), "import { s } from '../../../secret';\nexport const x = s;\n");
    const r = checkOverlayImports({ root, layers, files: ['src/brand/a.ts'] });
    assert.deepEqual(r.findings.map((f) => f.rule), ['import-outside-root']);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ CLI

const LAYERS = path.join(PACKAGE_ROOT, 'layers.json');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('CLI: the whole fixture overlay fails (negatives present) and names every expected rule', () => {
  const r = run('--root', tree.root, '--layers', LAYERS);
  assert.equal(r.status, 1, r.stdout);
  for (const rule of ['import-forbidden', 'import-l1-bypass', 'import-unclassified', 'import-unresolved', 'import-dynamic']) assert.match(r.stderr, new RegExp(rule));
});

test('CLI: positive fixtures alone pass', () => {
  const positives = tree.overlay.filter((o) => o.kind === 'positive').map((o) => o.rel);
  const r = run('--root', tree.root, '--layers', LAYERS, ...positives);
  assert.equal(r.status, 0, r.stderr);
});

test('CLI: base alone (no overlay list) checks nothing and passes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-base-'));
  try {
    fs.cpSync(path.join(PACKAGE_ROOT, 'layers.json'), path.join(root, 'layers.json'));
    const r = run('--root', root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /base alone/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --validate passes on the real tree', () => {
  const r = run('--validate');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /layers\.json valid/);
});
