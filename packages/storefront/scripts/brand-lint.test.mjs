import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PACKAGE_ROOT, loadLayers } from './check-imports.mjs';
import { lintProject, lintText, scopedFiles } from './brand-lint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'brand-lint.mjs');
const ROOT = path.join(HERE, 'fixtures', 'brand-lint', 'tree');
const LAYERS = path.join(PACKAGE_ROOT, 'layers.json');
const layers = loadLayers();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const rulesOf = (rel) => [...new Set(lintText(layers, rel, read(rel)).map((f) => f.rule))].sort();
const lintErr = (src, file = 'src/x.tsx') => [...new Set(lintText(layers, file, src).map((f) => f.rule))].sort();

// Each negative fixture names its rule on its first line ("expect: rule"); the file must yield exactly that rule.
for (const f of fs.readdirSync(path.join(ROOT, 'src', 'lint-negative')).filter((n) => !n.startsWith('overlay-'))) {
  const rel = `src/lint-negative/${f}`;
  const expected = read(rel).match(/expect: ([a-z-]+)/)[1];
  test(`negative ${f}: ${expected}`, () => {
    assert.deepEqual(rulesOf(rel), [expected]);
  });
}

for (const f of fs.readdirSync(path.join(ROOT, 'src', 'lint-positive'))) {
  test(`positive ${f}: no finding`, () => {
    assert.deepEqual(lintText(layers, `src/lint-positive/${f}`, read(`src/lint-positive/${f}`)), []);
  });
}

test('vendor-ui: provider id is exempt, a label beside it is not, exact positions are reported', () => {
  assert.deepEqual(lintErr("export const m = { provider: 'sezzle' };"), []);
  assert.deepEqual(lintErr("export const m = { provider: 'sezzle', label: 'Sezzle checkout' };"), ['vendor-ui']);
  assert.deepEqual(lintErr("export const m = { kind: 'sezzle' };"), ['vendor-ui']);
  const [hit] = lintText(layers, 'src/x.tsx', "\nexport const a = 'Pay with Sezzle';\n");
  assert.equal(hit.line, 2);
  assert.equal(hit.col, 28);
});

test('vendor-ui: vendorUiAllowFiles skips only that rule, only for the listed files', () => {
  const allowed = { ...layers, brandLint: { ...layers.brandLint, vendorUiAllowFiles: ['src/labels.ts'] } };
  const src = "export const a = 'Sezzle'; export const b = '#B87333';";
  const rules = (file) => [...new Set(lintText(allowed, file, src).map((f) => f.rule))].sort();
  assert.deepEqual(rules('src/labels.ts'), ['identity-colour']);
  assert.deepEqual(rules('src/other.ts'), ['identity-colour', 'vendor-ui']);
});

test('layers.json: the A20 vendor-ui allow list is exactly the provider label map and the env key list', () => {
  assert.deepEqual(layers.brandLint.vendorUiAllowFiles, ['src/platform/payments/labels.ts', 'src/env.ts']);
});

test('identity-colour: hex of any case, 8-digit alpha and r,g,b triplets; neutral colours pass', () => {
  assert.deepEqual(lintErr("export const a = '#b87333';"), ['identity-colour']);
  assert.deepEqual(lintErr("export const a = '#F5C518CC';"), ['identity-colour']);
  assert.deepEqual(lintErr("export const a = 'rgb(184,115,51)';"), ['identity-colour']);
  assert.deepEqual(lintErr("export const a = '#123456';"), []);
  assert.deepEqual(lintErr("export const a = 'rgb(1, 2, 3)';"), []);
});

test('brand-font and brand-name match whole words only; Inter is not a brand font', () => {
  assert.deepEqual(lintErr("export const a = 'IBM Plex Sans, sans-serif';"), ['brand-font']);
  assert.deepEqual(lintErr("export const a = 'Inter, system-ui';"), []);
  assert.deepEqual(lintErr("export const a = 'Fraunces';"), ['brand-font']);
  assert.deepEqual(lintErr("export const a = 'Unfraunces';"), []);
  assert.deepEqual(lintErr("export const a = 'Visit damneddesigns.com';"), ['brand-name']);
});

test('module specifiers, type literals, identifiers and comments are not scanned', () => {
  assert.deepEqual(lintErr("import x from '~/components/payment/Sezzle'; export const y = x;"), []);
  assert.deepEqual(lintErr("export type P = 'sezzle'; const sezzleFlag = 1; export { sezzleFlag }; // Damned Designs"), []);
});

test('scope: base files only (not L3, not tests, not overlay-origin); explicit files bypass the scope', () => {
  const overlay = fs.readFileSync(path.join(ROOT, '.compose-overlay-files.txt'), 'utf8').split('\n').filter(Boolean);
  const scoped = scopedFiles(ROOT, layers, overlay);
  assert.ok(scoped.includes('src/lint-negative/brand-name.tsx'));
  assert.equal(scoped.includes('src/brand/own-brand.tsx'), false, 'L3 is brand-owned');
  assert.equal(scoped.includes('src/skipped.test.ts'), false, 'tests are excluded');
  assert.equal(scoped.includes('src/lint-negative/overlay-owned.tsx'), false, 'overlay-origin is brand-owned');
  const explicit = lintProject({ root: ROOT, layers, files: ['src/brand/own-brand.tsx'] });
  assert.ok(explicit.length > 0);
});

const cli = (...args) => spawnSync(process.execPath, [SCRIPT, '--root', ROOT, '--layers', LAYERS, ...args], { encoding: 'utf8' });

test('CLI: warn mode (the layers.json default) reports and exits 0; block mode exits 1; positives alone pass in block mode', () => {
  assert.equal(loadLayers().brandLint.mode, 'warn');
  const warn = cli();
  assert.equal(warn.status, 0, warn.stderr);
  assert.match(warn.stdout, /warning src\/lint-negative\/brand-name\.tsx:\d+:\d+ brand-name/);
  assert.match(warn.stdout, /mode warn/);
  assert.doesNotMatch(warn.stdout, /own-brand|overlay-owned|skipped\.test/);

  const block = cli('--mode', 'block');
  assert.equal(block.status, 1, block.stdout);
  assert.match(block.stdout, /error src\/lint-negative\//);

  const ok = cli('--mode', 'block', 'src/lint-positive/clean.tsx', 'src/lint-positive/clean.css');
  assert.equal(ok.status, 0, ok.stdout);
});

test('CLI: an unknown mode is a usage error', () => {
  assert.notEqual(cli('--mode', 'loud').status, 0);
});
