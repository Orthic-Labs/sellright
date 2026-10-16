import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PACKAGE_ROOT, checkOverlayImports, loadLayers } from './check-imports.mjs';
import { shapeFindings } from './check-code-shape.mjs';
import { buildTree } from './fixtures/layers/build-tree.mjs';

// The compiled brand-view fixtures are real overlay code: placed in src/brand-slots they must pass every import and shape rule
// (r1-r13), exactly as a brand's own view would.
const layers = loadLayers();
const tree = buildTree();
after(() => tree.cleanup());
const FIXTURE_DIR = path.join(PACKAGE_ROOT, 'src/components/slots/__fixtures__/brand-views');

const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.tsx'));
for (const f of files) fs.copyFileSync(path.join(FIXTURE_DIR, f), (() => { fs.mkdirSync(path.join(tree.root, 'src/brand-slots'), { recursive: true }); return path.join(tree.root, 'src/brand-slots', f); })());

test('the brand-view fixtures pass the import checker as brand slots', () => {
  const rels = files.map((f) => `src/brand-slots/${f}`);
  const r = checkOverlayImports({ root: tree.root, layers, files: rels });
  assert.deepEqual(r.findings.map((x) => `${x.file} ${x.rule} ${x.message}`), []);
  assert.equal(r.checked, files.length);
});

test('the brand-view fixtures pass the code-shape checker', () => {
  for (const f of files) {
    const text = fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8');
    assert.deepEqual(shapeFindings(layers, `src/brand-slots/${f}`, text).map((x) => `${x.rule} ${x.message}`), [], f);
  }
});
