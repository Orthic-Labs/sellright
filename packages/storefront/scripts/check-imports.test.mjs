import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PACKAGE_ROOT, checkOverlayImports, classify, deployExemption, resolveDeployFiles, createResolver, importFindings, listProjectFiles, loadLayers, matchGlob, normalizeRel, transitiveFindings, validateTree } from './check-imports.mjs';
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
  assert.equal(layerOf('src/routes/products/[...slug]/ProductPageView.tsx'), 'L1', 'the legacy product seam is L1 now (route.product replaces it in PR2)');
  assert.equal(layerOf('src/routes/products/[...slug]/UnexpectedProductPageView.tsx'), 'L1');
  assert.equal(layerOf('src/components/header/header.tsx'), 'L1');
  assert.equal(layerOf('src/components/slots/registry.ts'), 'L1');
  assert.equal(layerOf('src/components/ui/LazyImage.tsx'), 'L1');
  assert.equal(layerOf('src/components/ui/Button.tsx'), 'L2');
  assert.equal(layerOf('src/components/Filters.tsx'), 'L2');
  assert.equal(layerOf('src/components/products/ProductCard.tsx'), 'L2');
  assert.equal(layerOf('src/components/account/Tab.tsx'), 'L2');
  assert.equal(layerOf('src/components/payment/NMI.tsx'), 'L1');
  assert.equal(layerOf('src/components/checkout/CheckoutPageView.tsx'), 'L1');
  assert.equal(layerOf('src/components/cart/Cart.tsx'), 'L1');
  assert.equal(layerOf('src/brand/tokens.css'), 'L3');
  assert.equal(layerOf('src/brand-slots/payment.badges.tsx'), 'L3');
  assert.equal(layerOf('public/brand/logo.svg'), 'L3');
  assert.equal(layerOf('src/theme/theme.config.ts'), 'L1');
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
    for (const rel of ['src/routes/x/index.tsx', 'src/other/t.ts', 'src/brand/ok.ts', 'public/favicon.ico']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), rel.endsWith('.ts') || rel.endsWith('.tsx') ? 'export const a = 1;\n' : 'x');
    }
    const r = checkOverlayImports({ root, layers, files: ['src/routes/x/index.tsx', 'src/other/t.ts', 'src/brand/ok.ts', 'public/favicon.ico'] });
    assert.deepEqual(r.findings.map((f) => `${f.file} ${f.rule}`).sort(), ['src/other/t.ts layer-unclassified', 'src/routes/x/index.tsx layer-l1-overlay']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('placement: a declared deploy file may sit in no layer; nothing else is exempted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-deploy-'));
  try {
    for (const rel of ['ecosystem.config.cjs', 'src/other/t.ts', 'src/routes/x/index.tsx']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), 'module.exports = {};\n');
    }
    const rules = (files, deployFiles) => checkOverlayImports({ root, layers, files, deployFiles }).findings.map((f) => `${f.file} ${f.rule}`).sort();
    assert.deepEqual(rules(['ecosystem.config.cjs']), ['ecosystem.config.cjs layer-unclassified'], 'undeclared: still rejected');
    assert.deepEqual(rules(['ecosystem.config.cjs'], ['ecosystem.config.cjs']), [], 'declared deploy file is accepted');
    assert.deepEqual(rules(['src/other/t.ts'], ['ecosystem.config.cjs']), ['src/other/t.ts layer-unclassified'], 'a source file that is not declared stays strict');
    assert.deepEqual(rules(['src/routes/x/index.tsx'], ['src/routes/x/index.tsx']), ['src/routes/x/index.tsx layer-l1-overlay'], 'declaring an L1 file does not unlock it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deploy exemption (layers.json deploy): only a declared, unclassified deploy file matching a deploy glob skips the source rules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-deploy-ex-'));
  const files = {
    'scripts/retain.mjs': "import fs from 'node:fs';\nexport const a = fs;\n",
    'scripts/other.mjs': "import fs from 'node:fs';\nexport const a = fs;\n",
    'public/ios-privacy-sw.js': 'self.registration.unregister();\n',
    'public/brand/x.js': 'alert(1);\n',
    'src/brand/x.ts': "import fs from 'node:fs';\nexport const a = fs;\n",
  };
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    const declared = ['scripts/retain.mjs', 'public/ios-privacy-sw.js', 'public/brand/x.js', 'src/brand/x.ts'];
    assert.equal(deployExemption(layers, 'scripts/retain.mjs', declared), 'operational');
    assert.equal(deployExemption(layers, 'public/ios-privacy-sw.js', declared), 'public');
    assert.equal(deployExemption(layers, 'scripts/other.mjs', declared), null, 'not declared');
    assert.equal(deployExemption(layers, 'public/brand/x.js', declared), null, 'classified (L3): never exempt');
    assert.equal(deployExemption(layers, 'src/brand/x.ts', declared), null, 'storefront source: never exempt');
    const rules = (list) => checkOverlayImports({ root, layers, files: list, deployFiles: declared }).findings.map((f) => `${f.file} ${f.rule}`).sort();
    assert.deepEqual(rules(['scripts/retain.mjs', 'public/ios-privacy-sw.js']), []);
    assert.ok(rules(['scripts/other.mjs']).includes('scripts/other.mjs layer-unclassified'));
    assert.ok(rules(['public/brand/x.js']).includes('public/brand/x.js overlay-executable-asset'));
    assert.ok(rules(['src/brand/x.ts']).some((r) => r.startsWith('src/brand/x.ts import-node')));
    // Exempt from the content rules, never from presence: a missing or symlinked deploy file is still a finding.
    const withLink = [...declared, 'scripts/gone.mjs', 'scripts/link.mjs'];
    fs.symlinkSync(path.join(root, 'src/brand/x.ts'), path.join(root, 'scripts/link.mjs'));
    const presence = checkOverlayImports({ root, layers, files: ['scripts/gone.mjs', 'scripts/link.mjs'], deployFiles: withLink }).findings.map((f) => `${f.file} ${f.rule}`).sort();
    assert.deepEqual(presence, ['scripts/gone.mjs file-missing', 'scripts/link.mjs file-symlink']);
    fs.writeFileSync(path.join(root, '.compose-deploy-files.txt'), 'scripts/retain.mjs\n');
    assert.deepEqual(resolveDeployFiles({}, root), ['scripts/retain.mjs']);
    const cli = spawnSync(process.execPath, [SCRIPT, '--root', root, '--layers', path.join(PACKAGE_ROOT, 'layers.json'), 'scripts/retain.mjs'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
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

// ------------------------------------------------------------------------------------------------ brand-views boundary (PR1)

test('r14 paths: every reclassified stateful component and the legacy product seam is L1 and not ejectable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-l1-eject-'));
  const l1Paths = [
    'src/routes/products/[...slug]/ProductPageView.tsx',
    'src/components/cart-totals/CartTotals.tsx',
    'src/components/cart-contents/CartContents.tsx',
    'src/components/address-form/AddressForm.tsx',
    'src/components/billing-address-form/BillingAddressForm.tsx',
    'src/components/customer-info-form/CustomerInfoForm.tsx',
    'src/components/account/AddressCard.tsx',
    'src/components/account/AccountNav.tsx',
    'src/components/account/OrderReturns.tsx',
    'src/components/loyalty/LoyaltyRedeem.tsx',
    'src/components/order-tracking/OrderDetails.tsx',
    'src/components/header/header.tsx',
    'src/components/menu/Menu.tsx',
    'src/components/footer/footer.tsx',
    'src/components/head/head.tsx',
    'src/components/auth/LoginModal.tsx',
    'src/components/verification/VerificationModal.tsx',
    'src/components/reviews/ProductReviews.tsx',
    'src/components/slots/registry.ts',
    'src/components/ui/LazyImage.tsx',
  ];
  try {
    for (const rel of l1Paths) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), 'export const a = 1;\n');
    }
    const r = checkOverlayImports({ root, layers, files: l1Paths });
    assert.deepEqual(r.findings.map((f) => `${f.file} ${f.rule}`).sort(), l1Paths.map((p) => `${p} layer-l1-overlay`).sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('r14 paths: the presentation components that stay L2 can still be ejected', () => {
  for (const rel of ['src/components/Filters.tsx', 'src/components/products/ProductCard.tsx', 'src/components/products/Price.tsx', 'src/components/home/HomeTeeSection.tsx', 'src/components/ui/Button.tsx', 'src/components/account/Tab.tsx', 'src/components/breadcrumbs/Breadcrumbs.tsx']) {
    assert.equal(classify(layers, rel)?.layer, 'L2', rel);
  }
});

test('r11: overlay public files may not be executable or documents; a clean SVG and a font pass', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-asset-'));
  const files = {
    'public/brand/x.js': 'alert(1)',
    'public/brand/x.mjs': 'export {}',
    'public/brand/x.wasm': '\0asm',
    'public/brand/page.html': '<p>x</p>',
    'public/brand/page.htm': '<p>x</p>',
    'public/brand/evil.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    'public/brand/handler.svg': '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>',
    'public/brand/link.svg': '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:x()"/></svg>',
    'public/brand/ok.svg': '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    'public/brand/font.woff2': 'wOF2',
  };
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    const r = checkOverlayImports({ root, layers, files: Object.keys(files) });
    const bad = new Set(r.findings.filter((f) => f.rule === 'overlay-executable-asset').map((f) => f.file));
    assert.deepEqual([...bad].sort(), ['public/brand/evil.svg', 'public/brand/handler.svg', 'public/brand/link.svg', 'public/brand/page.htm', 'public/brand/page.html', 'public/brand/x.js', 'public/brand/x.mjs', 'public/brand/x.wasm']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('r2/r3: allowed framework names pass, one forbidden name fails, type-only names follow the type: entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-fw-'));
  const run = (src) => {
    fs.mkdirSync(path.join(root, 'src/brand'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/brand/a.tsx'), src);
    return checkOverlayImports({ root, layers, files: ['src/brand/a.tsx'] }).findings.map((f) => f.rule);
  };
  try {
    fs.cpSync(path.join(PACKAGE_ROOT, 'scripts/fixtures/layers/tree'), root, { recursive: true });
    assert.deepEqual(run("import { component$, useSignal, type QRL } from '@qwik.dev/core';\nexport const a = [component$, useSignal] as unknown as QRL<() => void>;\n"), []);
    assert.deepEqual(run("import { useContext } from '@qwik.dev/core';\nexport const a = useContext;\n"), ['import-framework-symbol']);
    assert.deepEqual(run("import { QRL } from '@qwik.dev/core';\nexport const a: QRL<() => void> | null = null;\n"), ['import-framework-symbol']);
    assert.deepEqual(run("import type { Signal } from '@qwik.dev/core';\nexport const a: Signal<number> | null = null;\n"), []);
    assert.deepEqual(run("import { createContextId } from '@qwik.dev/core';\nexport const a = createContextId;\n"), ['import-framework-symbol']);
    assert.deepEqual(run("import { readFileSync } from 'fs/promises';\nexport const a = readFileSync;\n"), ['import-node']);
    assert.deepEqual(run("const m = await import('lodash');\nexport const a = m;\n"), ['import-framework-symbol']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('r4: a public platform module with a name list rejects other names and namespace imports; "*" accepts any name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-pub-'));
  try {
    fs.cpSync(path.join(PACKAGE_ROOT, 'scripts/fixtures/layers/tree'), root, { recursive: true });
    const run = (src) => {
      fs.writeFileSync(path.join(root, 'src/brand/a.tsx'), src);
      return checkOverlayImports({ root, layers, files: ['src/brand/a.tsx'] }).findings.map((f) => f.rule);
    };
    fs.mkdirSync(path.join(root, 'src/brand'), { recursive: true });
    assert.deepEqual(run("import type { BrandHeadSpec, StaticSchema } from '~/platform/head';\nexport const a: [BrandHeadSpec?, StaticSchema?] = [];\n"), []);
    assert.deepEqual(run("import * as h from '~/platform/head';\nexport const a = h;\n"), ['import-platform-private']);
    assert.deepEqual(run("import { formatMoney, type Cents } from '~/platform/views';\nexport const a: Cents = 1; export const b = formatMoney(a);\n"), []);
    assert.deepEqual(run("import * as v from '~/platform/views';\nexport const a = v;\n"), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('layers.json without the brand-views keys is rejected by loadLayers (a stale base cannot run the new checkers silently)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-stale-'));
  try {
    for (const key of ['platformApi.public', 'platformApi.reexports', 'imports.framework', 'imports.typeOnlyAllow', 'imports.transitiveL1Allow']) {
      const l = structuredClone(layers);
      const [a, b] = key.split('.');
      delete l[a][b];
      const file = path.join(dir, `${key}.json`);
      fs.writeFileSync(file, JSON.stringify(l));
      assert.throws(() => loadLayers(file), new RegExp(key.replace('.', '\\.')), key);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real tree: every presentation (L2) component a brand may import reaches only pure files (no adapter, context, env or unreviewed package)', () => {
  const resolver = createResolver(PACKAGE_ROOT);
  const readBase = (rel) => { const p = path.join(PACKAGE_ROOT, rel); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
  const l2 = listProjectFiles(PACKAGE_ROOT).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f) && classify(layers, f)?.layer === 'L2');
  for (const promised of ['src/components/home/HomeHero.tsx', 'src/components/home/HomeSocialSections.tsx', 'src/components/OrderProcessingModal.tsx', 'src/components/products/ProductCard.tsx', 'src/components/products/Price.tsx']) {
    assert.ok(l2.includes(promised), `${promised} is L2`);
  }
  // The real brand path: a brand file imports the component, so the component's OWN bare imports are checked too (starting the walk at
  // the L2 file itself would skip them).
  const PROBE = 'src/brand/reuse-probe.tsx';
  const bad = l2.flatMap((f) => {
    const spec = `~/${f.replace(/^src\//, '').replace(/\.tsx?$/, '')}`;
    const read = (rel) => (rel === PROBE ? `import X from '${spec}';\nexport const probe = X;\n` : readBase(rel));
    return [...importFindings({ layers, resolver }, PROBE, read(PROBE)), ...transitiveFindings({ layers, resolver }, PROBE, read)].map((x) => `${f}: ${x.rule} ${x.message}`);
  });
  assert.deepEqual(bad, []);
});

test('transitiveL1Allow lists files, never a directory glob over src/utils (the API adapter lives there)', () => {
  for (const g of layers.imports.transitiveL1Allow) assert.ok(!/^src\/utils\/\*/.test(g), `${g} is too wide`);
  assert.equal(layers.imports.transitiveL1Allow.some((g) => matchGlob(g, 'src/utils/sellright.ts')), false);
  assert.equal(layers.imports.transitiveL1Allow.some((g) => matchGlob(g, 'src/constants.ts')), false);
});
