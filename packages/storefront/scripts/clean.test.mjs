import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'clean.mjs');
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'sr-clean-'));
  roots.push(root);
  for (const d of ['dist', 'server', '.cache']) {
    mkdirSync(join(root, d, 'nested'), { recursive: true });
    writeFileSync(join(root, d, 'nested', 'f.txt'), 'x');
  }
  for (const d of ['src', 'dist-e2e', 'server-e2e', 'public']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'package.json'), '{}');
  return root;
}

test('removes dist, server and .cache and nothing else', () => {
  const root = tree();
  const r = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const d of ['dist', 'server', '.cache']) assert.equal(existsSync(join(root, d)), false, d);
  for (const d of ['src', 'dist-e2e', 'server-e2e', 'public', 'package.json']) assert.equal(existsSync(join(root, d)), true, d);
});

test('is idempotent when the targets are already gone', () => {
  const root = mkdtempSync(join(tmpdir(), 'sr-clean-'));
  roots.push(root);
  assert.equal(spawnSync(process.execPath, [script, root]).status, 0);
  assert.equal(spawnSync(process.execPath, [script, root]).status, 0);
});

test('with no argument it cleans the parent of its own scripts/ directory, whatever the cwd', () => {
  const root = tree();
  mkdirSync(join(root, 'scripts'));
  copyFileSync(script, join(root, 'scripts', 'clean.mjs'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'sr-clean-cwd-'));
  roots.push(elsewhere);
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'clean.mjs')], { cwd: elsewhere, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const d of ['dist', 'server', '.cache']) assert.equal(existsSync(join(root, d)), false, d);
  assert.equal(existsSync(join(root, 'scripts', 'clean.mjs')), true);
});
