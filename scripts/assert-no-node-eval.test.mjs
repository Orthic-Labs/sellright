// node --test scripts/assert-no-node-eval.test.mjs   (from the repo root)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const guard = join(dirname(fileURLToPath(import.meta.url)), 'assert-no-node-eval.sh');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function layout({ storefrontScripts = {}, clientScripts = {}, extraFiles = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sr-nne-'));
  roots.push(root);
  for (const [pkg, scripts] of [['storefront', storefrontScripts], ['storefront-client', clientScripts]]) {
    mkdirSync(join(root, 'packages', pkg, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'packages', pkg, 'package.json'), JSON.stringify({ name: pkg, scripts }, null, 2));
  }
  for (const [rel, body] of Object.entries(extraFiles)) writeFileSync(join(root, rel), body);
  return root;
}
const run = (root) => spawnSync('bash', [guard], { env: { ...process.env, ASSERT_NO_NODE_EVAL_ROOT: root }, encoding: 'utf8' });

test('passes on a clean layout', () => {
  const r = run(layout({ storefrontScripts: { clean: 'node scripts/clean.mjs', build: 'vite build --print-something' } }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a positional script path ends the match: trailing -p / --print are script arguments', () => {
  const r = run(layout({ storefrontScripts: { x: 'node scripts/tool.mjs -p 3000', y: 'node scripts/tool.mjs --print' } }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

for (const cmd of [
  'node -e "process.exit(0)"',
  'node --eval "1"',
  'node -p "1"',
  'node --print 1',
  'node -pe "1"',
  'node --no-warnings -e "1"',
  'node --input-type=module -e "1"',
  'node --import ./x.mjs -e "1"',
  'node -r ./x.cjs -p "1"',
  'pnpm run a && node -e "1"',
]) {
  test(`fails on package.json script: ${cmd}`, () => {
    const r = run(layout({ storefrontScripts: { bad: cmd } }));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /inline node eval in packages\/storefront\/package\.json/);
  });
}

test('fails on the client package.json', () => {
  const r = run(layout({ clientScripts: { 'build.copy-generated': 'node -e "1"' } }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /storefront-client\/package\.json/);
});

test('fails on an eval inside a scripts/ file (shell and mjs)', () => {
  const sh = run(layout({ extraFiles: { 'packages/storefront/scripts/a.sh': '#!/bin/sh\nnode -e "1"\n' } }));
  assert.equal(sh.status, 1);
  assert.match(sh.stdout, /packages\/storefront\/scripts/);
  const client = run(layout({ extraFiles: { 'packages/storefront-client/scripts/b.mjs': "execSync('node --eval 1')\n" } }));
  assert.equal(client.status, 1);
  assert.match(client.stdout, /packages\/storefront-client\/scripts/);
});

test('fails when a scan target is missing (a moved package must not silently pass)', () => {
  const root = layout();
  rmSync(join(root, 'packages', 'storefront-client', 'scripts'), { recursive: true });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing scan target/);
});

test('the real repo is clean (needs the #182 base: clean/copy-generated are checked-in scripts)', () => {
  const r = spawnSync('bash', [guard], { env: { ...process.env, ASSERT_NO_NODE_EVAL_ROOT: repoRoot }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
